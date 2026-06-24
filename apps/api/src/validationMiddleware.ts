import type { Request, Response, NextFunction } from 'express';
import { ZodError, ZodSchema } from 'zod';

export function validateBody(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        res.status(400).json({
          error: 'Validation error',
          details: err.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        });
        return;
      }
      next(err);
    }
  };
}

export function validateQuery(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      (req as any).validatedQuery = schema.parse(req.query);
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        res.status(400).json({
          error: 'Validation error',
          details: err.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        });
        return;
      }
      next(err);
    }
  };
}

export function validateParams(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      req.params = schema.parse(req.params) as any;
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        res.status(400).json({
          error: 'Validation error',
          details: err.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        });
        return;
      }
      next(err);
    }
  };
}
