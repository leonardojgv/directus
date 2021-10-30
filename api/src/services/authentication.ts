import jwt from 'jsonwebtoken';
import { Knex } from 'knex';
import ms from 'ms';
import { nanoid } from 'nanoid';
import getDatabase from '../database';
import emitter, { emitAsyncSafe } from '../emitter';
import env from '../env';
import { getAuthProvider } from '../auth';
import { DEFAULT_AUTH_PROVIDER } from '../constants';
import { InvalidCredentialsException, InvalidOTPException, UserSuspendedException } from '../exceptions';
import { createRateLimiter } from '../rate-limiter';
import { ActivityService } from './activity';
import { TFAService } from './tfa';
import { AbstractServiceOptions, Action, SchemaOverview, Session, User, SessionData } from '../types';
import { Accountability } from '@directus/shared/types';
import { SettingsService } from './settings';
import { merge, clone, cloneDeep, omit } from 'lodash';
import { performance } from 'perf_hooks';
import { stall } from '../utils/stall';
import logger from '../logger';

const loginAttemptsLimiter = createRateLimiter({ duration: 0 });

export class AuthenticationService {
	knex: Knex;
	accountability: Accountability | null;
	activityService: ActivityService;
	schema: SchemaOverview;

	constructor(options: AbstractServiceOptions) {
		this.knex = options.knex || getDatabase();
		this.accountability = options.accountability || null;
		this.activityService = new ActivityService({ knex: this.knex, schema: options.schema });
		this.schema = options.schema;
	}

	/**
	 * Retrieve the tokens for a given user email.
	 *
	 * Password is optional to allow usage of this function within the SSO flow and extensions. Make sure
	 * to handle password existence checks elsewhere
	 */
	async login(
		providerName: string = DEFAULT_AUTH_PROVIDER,
		payload: Record<string, any>,
		otp?: string
	): Promise<{ accessToken: any; refreshToken: any; expires: any; id?: any }> {
		const STALL_TIME = 100;
		const timeStart = performance.now();

		const provider = getAuthProvider(providerName);

		const user = await this.knex
			.select<User & { tfa_secret: string | null }>(
				'id',
				'first_name',
				'last_name',
				'email',
				'password',
				'status',
				'role',
				'tfa_secret',
				'provider',
				'external_identifier',
				'auth_data'
			)
			.from('directus_users')
			.where('id', await provider.getUserID(cloneDeep(payload)))
			.andWhere('provider', providerName)
			.first();

		const updatedPayload = await emitter.emitAsync('auth.login.before', {
			event: 'auth.login.before',
			action: 'login',
			schema: this.schema,
			payload: payload,
			provider: providerName,
			accountability: this.accountability,
			status: 'pending',
			user: user?.id,
			database: this.knex,
		});

		if (updatedPayload) {
			payload = updatedPayload.length > 0 ? updatedPayload.reduce((acc, val) => merge(acc, val), {}) : payload;
		}

		const emitStatus = (status: 'fail' | 'success') => {
			emitAsyncSafe('auth.login', {
				event: 'auth.login',
				action: 'login',
				schema: this.schema,
				payload: payload,
				provider: providerName,
				accountability: this.accountability,
				status,
				user: user?.id,
				database: this.knex,
			});
		};

		if (user?.status !== 'active') {
			emitStatus('fail');

			if (user?.status === 'suspended') {
				await stall(STALL_TIME, timeStart);
				throw new UserSuspendedException();
			} else {
				await stall(STALL_TIME, timeStart);
				throw new InvalidCredentialsException();
			}
		}

		const settingsService = new SettingsService({
			knex: this.knex,
			schema: this.schema,
		});

		const { auth_login_attempts: allowedAttempts } = await settingsService.readSingleton({
			fields: ['auth_login_attempts'],
		});

		if (allowedAttempts !== null) {
			loginAttemptsLimiter.points = allowedAttempts;

			try {
				await loginAttemptsLimiter.consume(user.id);
			} catch {
				await this.knex('directus_users').update({ status: 'suspended' }).where({ id: user.id });
				user.status = 'suspended';

				// This means that new attempts after the user has been re-activated will be accepted
				await loginAttemptsLimiter.set(user.id, 0, 0);
			}
		}

		let sessionData: SessionData = null;

		try {
			sessionData = await provider.login(clone(user), cloneDeep(payload));
		} catch (e) {
			emitStatus('fail');
			await stall(STALL_TIME, timeStart);
			throw e;
		}

		if (user.tfa_secret && !otp) {
			emitStatus('fail');
			await stall(STALL_TIME, timeStart);
			throw new InvalidOTPException(`"otp" is required`);
		}

		if (user.tfa_secret && otp) {
			const tfaService = new TFAService({ knex: this.knex, schema: this.schema });
			const otpValid = await tfaService.verifyOTP(user.id, otp);

			if (otpValid === false) {
				emitStatus('fail');
				await stall(STALL_TIME, timeStart);
				throw new InvalidOTPException(`"otp" is invalid`);
			}
		}

		let tokenPayload = {
			id: user.id,
		};

		const customClaims = await emitter.emitAsync('auth.jwt.before', tokenPayload, {
			event: 'auth.jwt.before',
			action: 'jwt',
			schema: this.schema,
			payload: tokenPayload,
			provider: providerName,
			accountability: this.accountability,
			status: 'pending',
			user: user?.id,
			database: this.knex,
		});

		if (customClaims) {
			tokenPayload =
				customClaims.length > 0 ? customClaims.reduce((acc, val) => merge(acc, val), tokenPayload) : tokenPayload;
		}

		const accessToken = jwt.sign(tokenPayload, env.SECRET as string, {
			expiresIn: env.ACCESS_TOKEN_TTL,
			issuer: 'directus',
		});

		const refreshToken = nanoid(64);
		const refreshTokenExpiration = new Date(Date.now() + ms(env.REFRESH_TOKEN_TTL as string));

		await this.knex('directus_sessions').insert({
			token: refreshToken,
			user: user.id,
			expires: refreshTokenExpiration,
			ip: this.accountability?.ip,
			user_agent: this.accountability?.userAgent,
			data: sessionData && JSON.stringify(sessionData),
		});

		await this.knex('directus_sessions').delete().where('expires', '<', new Date());

		if (this.accountability) {
			await this.activityService.createOne({
				action: Action.LOGIN,
				user: user.id,
				ip: this.accountability.ip,
				user_agent: this.accountability.userAgent,
				collection: 'directus_users',
				item: user.id,
			});
		}

		await this.knex('directus_users').update({ last_access: new Date() }).where({ id: user.id });

		emitStatus('success');

		if (allowedAttempts !== null) {
			await loginAttemptsLimiter.set(user.id, 0, 0);
		}

		await stall(STALL_TIME, timeStart);

		return {
			accessToken,
			refreshToken,
			expires: ms(env.ACCESS_TOKEN_TTL as string),
			id: user.id,
		};
	}

	async refresh(refreshToken: string): Promise<Record<string, any>> {
		if (!refreshToken) {
			throw new InvalidCredentialsException();
		}

		const record = await this.knex
			.select<Session & User>(
				's.expires',
				's.data',
				'u.id',
				'u.first_name',
				'u.last_name',
				'u.email',
				'u.password',
				'u.status',
				'u.role',
				'u.provider',
				'u.external_identifier',
				'u.auth_data'
			)
			.from('directus_sessions as s')
			.innerJoin('directus_users as u', 's.user', 'u.id')
			.where('s.token', refreshToken)
			.first();

		if (!record || record.expires < new Date()) {
			throw new InvalidCredentialsException();
		}

		let { data: sessionData } = record;
		const user = omit(record, 'data');

		if (typeof sessionData === 'string') {
			try {
				sessionData = JSON.parse(sessionData);
			} catch {
				logger.warn(`Session data isn't valid JSON: ${sessionData}`);
			}
		}

		const provider = getAuthProvider(user.provider);

		const newSessionData = await provider.refresh(clone(user), sessionData as SessionData);

		const accessToken = jwt.sign({ id: user.id }, env.SECRET as string, {
			expiresIn: env.ACCESS_TOKEN_TTL,
			issuer: 'directus',
		});

		const newRefreshToken = nanoid(64);
		const refreshTokenExpiration = new Date(Date.now() + ms(env.REFRESH_TOKEN_TTL as string));

		await this.knex('directus_sessions')
			.update({
				token: newRefreshToken,
				expires: refreshTokenExpiration,
				data: newSessionData && JSON.stringify(newSessionData),
			})
			.where({ token: refreshToken });

		await this.knex('directus_users').update({ last_access: new Date() }).where({ id: user.id });

		return {
			accessToken,
			refreshToken: newRefreshToken,
			expires: ms(env.ACCESS_TOKEN_TTL as string),
			id: user.id,
		};
	}

	async logout(refreshToken: string): Promise<void> {
		const record = await this.knex
			.select<User & Session>(
				'u.id',
				'u.first_name',
				'u.last_name',
				'u.email',
				'u.password',
				'u.status',
				'u.role',
				'u.provider',
				'u.external_identifier',
				'u.auth_data',
				's.data'
			)
			.from('directus_sessions as s')
			.innerJoin('directus_users as u', 's.user', 'u.id')
			.where('s.token', refreshToken)
			.first();

		if (record) {
			let { data: sessionData } = record;
			const user = omit(record, 'data');

			if (typeof sessionData === 'string') {
				try {
					sessionData = JSON.parse(sessionData);
				} catch {
					logger.warn(`Session data isn't valid JSON: ${sessionData}`);
				}
			}

			const provider = getAuthProvider(user.provider);
			await provider.logout(clone(user), sessionData as SessionData);

			await this.knex.delete().from('directus_sessions').where('token', refreshToken);
		}
	}

	async verifyPassword(userID: string, password: string): Promise<void> {
		const user = await this.knex
			.select<User>(
				'id',
				'first_name',
				'last_name',
				'email',
				'password',
				'status',
				'role',
				'provider',
				'external_identifier',
				'auth_data'
			)
			.from('directus_users')
			.where('id', userID)
			.first();

		if (!user) {
			throw new InvalidCredentialsException();
		}

		const provider = getAuthProvider(user.provider);
		await provider.verify(clone(user), password);
	}
}
