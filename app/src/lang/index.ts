import { RequestError } from '@/api';
import { createI18n } from 'vue-i18n';
import availableLanguages from './available-languages.yaml';
import datetimeFormats from './date-formats.yaml';
import numberFormats from './number-formats.yaml';
import enESBase from './translations/es-ES.yaml';

export const i18n = createI18n({
	legacy: false,
	locale: 'en-ES',
	fallbackLocale: 'en-ES',
	messages: {
		'en-ES': enESBase,
	},
	silentTranslationWarn: true,
	datetimeFormats,
	numberFormats,
});

export type Language = keyof typeof availableLanguages;

export const loadedLanguages: Language[] = ['en-ES'];

export function translateAPIError(error: RequestError | string): string {
	const defaultMsg = i18n.global.t('unexpected_error');

	let code = error;

	if (typeof error === 'object') {
		code = error?.response?.data?.errors?.[0]?.extensions?.code;
	}

	if (!error) return defaultMsg;
	if (!code === undefined) return defaultMsg;
	const key = `errors.${code}`;

	const exists = i18n.global.te(key);
	if (exists === false) return defaultMsg;
	return i18n.global.t(key);
}
