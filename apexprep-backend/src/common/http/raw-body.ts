import type { NextFunction, Request, Response } from 'express';

/** Thrown when the body exceeds the limit. The shape body-parser uses, so the error filter already maps it to 413. */
interface TooLargeError extends Error {
  type: 'entity.too.large';
  status: number;
  expected: number;
  limit: number;
}

/** How much of a refused upload is read and discarded before the connection is cut. */
const DRAIN_ALLOWANCE_BYTES = 8 * 1024 * 1024;

/**
 * Buffers the request body for one content type, up to a byte limit.
 *
 * Source PDFs are uploaded as the raw request body rather than as multipart: no multipart parser
 * is installed (the registry is blocked — DECISIONS.md §D), and a single-file upload does not need
 * one. This is that reader, deliberately narrow — it touches only requests whose `Content-Type`
 * matches, so every other route keeps the JSON parsing it already had.
 *
 * The limit is enforced **while reading**, not after: the connection is refused the moment the
 * count passes it, so an attempt to upload a file far over the ceiling never occupies memory for
 * the whole of it. The error carries body-parser's own `type` and `status`, which the exception
 * filter already turns into `413 PAYLOAD_TOO_LARGE`, so an oversized upload answers in the
 * project's error shape rather than Express's.
 *
 * What is refused is not buffered, but a little of it is still *read and discarded* before the connection is cut.
 * Closing a socket on a client that is mid-upload makes the operating system reset it, and a client that has been
 * reset never reads the 413 that explains why: on Windows, and behind some proxies, an oversized upload then looks
 * like a dropped connection rather than "this file is too large". The allowance is small and fixed, so a hostile
 * client still cannot make the server absorb more than that.
 */
export function rawBodyMiddleware(contentType: string, limitBytes: number) {
  return function readRawBody(req: Request, res: Response, next: NextFunction): void {
    const declared = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
    if (declared !== contentType) return next();
    // Something upstream already read it (a test posting a Buffer through a parser, say).
    if (Buffer.isBuffer(req.body)) return next();

    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const done = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', done);
      next(error);
    };

    function onData(chunk: Buffer): void {
      size += chunk.length;
      if (size > limitBytes) {
        const error: TooLargeError = Object.assign(new Error('request entity too large'), {
          type: 'entity.too.large' as const,
          status: 413,
          expected: size,
          limit: limitBytes,
        });
        // Nothing more is kept. The rest of the body, up to the allowance, is read and thrown away so the client
        // can finish sending and read the 413; past the allowance the connection is cut.
        chunks.length = 0;
        done(error);
        let discarded = size;
        // The listeners that fed the buffer are gone; a reset from here on is the client giving up, not our error.
        req.on('error', () => undefined);
        req.on('data', (extra: Buffer) => {
          discarded += extra.length;
          if (discarded > limitBytes + DRAIN_ALLOWANCE_BYTES) req.destroy();
        });
        return;
      }
      chunks.push(chunk);
    }

    function onEnd(): void {
      req.body = Buffer.concat(chunks);
      done();
    }

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', done);
  };
}
