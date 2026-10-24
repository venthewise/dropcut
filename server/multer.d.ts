declare module "multer" {
  import type { RequestHandler } from "express";

  interface File {
    fieldname: string;
    originalname: string;
    encoding: string;
    mimetype: string;
    size: number;
    buffer: Buffer;
  }

  interface Options {
    storage?: unknown;
    limits?: {
      fileSize?: number;
      files?: number;
      fields?: number;
      fieldSize?: number;
    };
  }

  interface Field {
    name: string;
    maxCount?: number;
  }

  interface Multer {
    array(fieldName: string, maxCount?: number): RequestHandler;
    fields(fields: Field[]): RequestHandler;
  }

  class MulterError extends Error {
    code: string;
    field?: string;
  }

  interface MulterFactory {
    (options?: Options): Multer;
    memoryStorage(): unknown;
    MulterError: typeof MulterError;
  }

  const multer: MulterFactory;
  export = multer;
}
