import type { Request, Response, NextFunction } from "express";
import pino from "pino";

const logger = pino({ name: "maximus-server" });

export function errorHandler(
	err: Error,
	_req: Request,
	res: Response,
	_next: NextFunction,
): void {
	logger.error({ err: err.message, stack: err.stack }, "Unhandled error");
	res.status(500).json({ error: err.message });
}

export function notFoundHandler(_req: Request, res: Response): void {
	res.status(404).json({ error: "Not found" });
}
