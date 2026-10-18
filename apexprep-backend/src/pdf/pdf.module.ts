import { Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
import { OCR_PROVIDER, UnavailableOcrProvider, type OcrProvider } from './ocr-provider';

/**
 * The PDF and OCR boundary as a module.
 *
 * `PdfDocument` is a pure class with no dependencies, so it is imported directly where it is
 * needed rather than injected. Only OCR is bound here, because which provider runs is
 * configuration.
 */
const ocr: Provider = {
  provide: OCR_PROVIDER,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): OcrProvider => {
    const provider = config.get('OCR_PROVIDER', { infer: true });
    // Only 'none' exists today. A commercial provider is a class implementing OcrProvider plus a
    // case here: nothing above this file names one, so nothing above it has to change.
    if (provider === 'none') return new UnavailableOcrProvider();
    throw new Error(`OCR_PROVIDER=${String(provider)} has no adapter`);
  },
};

@Module({ providers: [ocr], exports: [OCR_PROVIDER] })
export class PdfModule {}
