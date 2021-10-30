import { Router } from 'express';
import { Issuer, Client, generators, errors } from 'openid-client';
import jwt from 'jsonwebtoken';
import ms from 'ms';
import { LocalAuthDriver } from './local';
import { getAuthProvider } from '../../auth';
import env from '../../env';
import { AuthenticationService, UsersService } from '../../services';
import { AuthDriverOptions, User, AuthData, SessionData } from '../../types';
import { InvalidCredentialsException, ServiceUnavailableException, InvalidConfigException } from '../../exceptions';
import { respond } from '../../middleware/respond';
import asyncHandler from '../../utils/async-handler';
import { Url } from '../../utils/url';
import logger from '../../logger';

export class OpenIDAuthDriver extends LocalAuthDriver {
	client: Promise<Client>;
	redirectUrl: string;
	usersService: UsersService;
	config: Record<string, any>;

	constructor(options: AuthDriverOptions, config: Record<string, any>) {
		super(options, config);

		const { issuerUrl, clientId, clientSecret, ...additionalConfig } = config;

		if (!issuerUrl || !clientId || !clientSecret || !additionalConfig.provider) {
			throw new InvalidConfigException('Invalid provider config', { provider: additionalConfig.provider });
		}

		const redirectUrl = new Url(env.PUBLIC_URL).addPath('auth', 'login', additionalConfig.provider, 'callback');

		this.redirectUrl = redirectUrl.toString();
		this.usersService = new UsersService({ knex: this.knex, schema: this.schema });
		this.config = additionalConfig;
		this.client = new Promise((resolve, reject) => {
			Issuer.discover(issuerUrl)
				.then((issuer) => {
					resolve(
						new issuer.Client({
							client_id: clientId,
							client_secret: clientSecret,
							redirect_uris: [this.redirectUrl],
							response_types: ['code'],
						})
					);
				})
				.catch(reject);
		});
	}

	generateCodeVerifier(): string {
		return generators.codeVerifier();
	}

	async generateAuthUrl(codeVerifier: string): Promise<string> {
		try {
			const client = await this.client;
			return client.authorizationUrl({
				scope: this.config.scope ?? 'openid profile email',
				code_challenge: generators.codeChallenge(codeVerifier),
				code_challenge_method: 'S256',
				access_type: 'offline',
			});
		} catch (e) {
			throw handleError(e);
		}
	}

	private async fetchUserId(identifier: string): Promise<string | undefined> {
		const user = await this.knex
			.select('id')
			.from('directus_users')
			.whereRaw('LOWER(??) = ?', ['external_identifier', identifier.toLowerCase()])
			.first();

		return user?.id;
	}

	async getUserID(payload: Record<string, any>): Promise<string> {
		if (!payload.code || !payload.codeVerifier) {
			throw new InvalidCredentialsException();
		}

		let tokenSet;
		let userInfo;

		try {
			const client = await this.client;
			tokenSet = await client.callback(
				this.redirectUrl,
				{ code: payload.code },
				{ code_verifier: payload.codeVerifier }
			);
			userInfo = await client.userinfo(tokenSet);
		} catch (e) {
			throw handleError(e);
		}

		const { identifierKey, allowPublicRegistration, requireVerifiedEmail } = this.config;

		const email = userInfo.email as string | null | undefined;
		// Fallback to email if explicit identifier not found
		const identifier = (userInfo[identifierKey ?? 'sub'] as string | null | undefined) ?? email;

		if (!identifier) {
			logger.warn(`Failed to find user identifier for provider "${this.config.provider}"`);
			throw new InvalidCredentialsException();
		}

		const userId = await this.fetchUserId(identifier);

		if (userId) {
			// Update user refreshToken if provided
			if (tokenSet.refresh_token) {
				await this.usersService.updateOne(userId, {
					auth_data: JSON.stringify({ refreshToken: tokenSet.refresh_token }),
				});
			}
			return userId;
		}

		const isEmailVerified = !requireVerifiedEmail || userInfo.email_verified;

		// Is public registration allowed?
		if (!allowPublicRegistration || !isEmailVerified) {
			throw new InvalidCredentialsException();
		}

		await this.usersService.createOne({
			provider: this.config.provider,
			first_name: userInfo.given_name,
			last_name: userInfo.family_name,
			email: email,
			external_identifier: identifier,
			role: this.config.defaultRoleId,
			auth_data: tokenSet.refresh_token && JSON.stringify({ refreshToken: tokenSet.refresh_token }),
		});

		return (await this.fetchUserId(identifier)) as string;
	}

	async login(user: User, sessionData: SessionData): Promise<SessionData> {
		return this.refresh(user, sessionData);
	}

	async refresh(user: User, sessionData: SessionData): Promise<SessionData> {
		let authData = user.auth_data as AuthData;

		if (typeof authData === 'string') {
			try {
				authData = JSON.parse(authData);
			} catch {
				logger.warn(`Session data isn't valid JSON: ${authData}`);
			}
		}

		if (!authData?.refreshToken) {
			return sessionData;
		}

		try {
			const client = await this.client;
			const tokenSet = await client.refresh(authData.refreshToken);
			return { accessToken: tokenSet.access_token };
		} catch (e) {
			throw handleError(e);
		}
	}
}

const handleError = (e: any) => {
	if (e instanceof errors.OPError) {
		if (e.error === 'invalid_grant') {
			// Invalid token
			return new InvalidCredentialsException();
		}
		// Server response error
		return new ServiceUnavailableException('Service returned unexpected response', {
			service: 'openid',
			message: e.error_description,
		});
	} else if (e instanceof errors.RPError) {
		// Internal client error
		return new InvalidCredentialsException();
	}
	return e;
};

export function createOpenIDAuthRouter(providerName: string): Router {
	const router = Router();

	router.get(
		'/',
		asyncHandler(async (req, res) => {
			const provider = getAuthProvider(providerName) as OpenIDAuthDriver;
			const codeVerifier = provider.generateCodeVerifier();
			const token = jwt.sign({ verifier: codeVerifier, redirect: req.query.redirect }, env.SECRET as string, {
				expiresIn: '5m',
				issuer: 'directus',
			});

			res.cookie(`openid.${providerName}`, token, {
				httpOnly: true,
				sameSite: 'lax',
			});

			return res.redirect(await provider.generateAuthUrl(codeVerifier));
		}),
		respond
	);

	router.get(
		'/callback',
		asyncHandler(async (req, res, next) => {
			let tokenData;

			try {
				tokenData = jwt.verify(req.cookies[`openid.${providerName}`], env.SECRET as string, { issuer: 'directus' }) as {
					verifier: string;
					redirect?: string;
				};
			} catch (e) {
				throw new InvalidCredentialsException();
			}

			const { verifier, redirect } = tokenData;

			const authenticationService = new AuthenticationService({
				accountability: {
					ip: req.ip,
					userAgent: req.get('user-agent'),
					role: null,
				},
				schema: req.schema,
			});

			let authResponse;

			try {
				res.clearCookie(`openid.${providerName}`);

				if (!req.query.code) {
					logger.warn(`Couldn't extract OAuth2 code from query: ${JSON.stringify(req.query)}`);
				}

				authResponse = await authenticationService.login(providerName, {
					code: req.query.code,
					codeVerifier: verifier,
				});
			} catch (error: any) {
				logger.warn(error);

				if (redirect) {
					let reason = 'UNKNOWN_EXCEPTION';

					if (error instanceof ServiceUnavailableException) {
						reason = 'SERVICE_UNAVAILABLE';
					} else if (error instanceof InvalidCredentialsException) {
						reason = 'INVALID_USER';
					}

					return res.redirect(`${redirect.split('?')[0]}?reason=${reason}`);
				}

				throw error;
			}

			const { accessToken, refreshToken, expires } = authResponse;

			if (redirect) {
				res.cookie(env.REFRESH_TOKEN_COOKIE_NAME, refreshToken, {
					httpOnly: true,
					domain: env.REFRESH_TOKEN_COOKIE_DOMAIN,
					maxAge: ms(env.REFRESH_TOKEN_TTL as string),
					secure: env.REFRESH_TOKEN_COOKIE_SECURE ?? false,
					sameSite: (env.REFRESH_TOKEN_COOKIE_SAME_SITE as 'lax' | 'strict' | 'none') || 'strict',
				});

				return res.redirect(redirect);
			}

			res.locals.payload = {
				data: { access_token: accessToken, refresh_token: refreshToken, expires },
			};

			next();
		}),
		respond
	);

	return router;
}
