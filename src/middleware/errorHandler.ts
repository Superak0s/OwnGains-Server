import { Request, Response, NextFunction } from "express"
import { logger } from "../utils/logger.js"

export class AppError extends Error {
  statusCode: number
  details: unknown
  // Machine-readable discriminator for clients that need to tell two errors
  // with the same status apart (see REFRESH_REUSED).
  code?: string

  constructor(
    message: string,
    statusCode = 500,
    details: unknown = null,
    code?: string,
  ) {
    super(message)
    this.statusCode = statusCode
    this.details = details
    this.code = code
    Error.captureStackTrace(this, this.constructor)
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details: unknown = null, code?: string) {
    super(message, 400, details, code)
  }
}

export class NotFoundError extends AppError {
  constructor(resource = "Resource") {
    super(`${resource} not found`, 404)
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized", code?: string) {
    super(message, 401, null, code)
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Access denied", code?: string) {
    super(message, 403, null, code)
  }
}

export class ConflictError extends AppError {
  constructor(message: string, code?: string, details: unknown = null) {
    super(message, 409, details, code)
  }
}

/**
 * A violated CHECK constraint (or out-of-range value) is a bad request, not a
 * server error. Matched on errno, not err.code: mysql2's name table predates
 * 4025 and mislabels it (ER_INNODB_AUTOEXTEND_SIZE_OUT_OF_RANGE).
 * 3819 = ER_CHECK_CONSTRAINT_VIOLATED (MySQL 8), 4025 = ER_CONSTRAINT_FAILED
 * (MariaDB), 1264 = ER_WARN_DATA_OUT_OF_RANGE, 1265 = WARN_DATA_TRUNCATED.
 */
export function throwCheckViolation(err: unknown, message: string): never {
  const errno = (err as { errno?: number }).errno
  if (errno === 3819 || errno === 4025 || errno === 1264 || errno === 1265)
    throw new ValidationError(message)
  throw err
}

/**
 * Errors that mean "the database is overloaded or briefly unreachable", not
 * "this request is broken": the pool's bounded wait queue is full, a
 * connection couldn't be opened in time, or the server killed a statement at
 * its timeout / picked it as a deadlock or lock-wait victim. The client should
 * back off and retry, so these answer 503 + Retry-After instead of a 500 that
 * reads as a server bug.
 * 3024 = ER_QUERY_TIMEOUT (MySQL max_execution_time), 1969 =
 * ER_STATEMENT_TIMEOUT (MariaDB max_statement_time), 1040 = ER_CON_COUNT_ERROR
 * (too many connections), 1205 = ER_LOCK_WAIT_TIMEOUT, 1213 = ER_LOCK_DEADLOCK.
 */
const RETRYABLE_DB_ERRNOS = new Set([3024, 1969, 1040, 1205, 1213])
const RETRYABLE_DB_CODES = new Set([
  "ETIMEDOUT",
  "ECONNREFUSED",
  "PROTOCOL_CONNECTION_LOST",
  "PROTOCOL_SEQUENCE_TIMEOUT",
])
const DB_RETRY_AFTER_S = 5

export function isDbUnavailableError(err: unknown): boolean {
  const e = err as { errno?: number; code?: string; message?: string }
  // mysql2 raises a plain Error with no code when the pool's queue is full.
  return (
    RETRYABLE_DB_ERRNOS.has(e.errno ?? 0) ||
    RETRYABLE_DB_CODES.has(e.code ?? "") ||
    e.message === "Queue limit reached."
  )
}

interface ErrorResponse {
  success: false
  error: string
  /** Same id as the request log line, so a user can quote it and it's greppable. */
  reqId?: string
  code?: string
  details?: unknown
  stack?: string
}

export function errorHandler(
  err: AppError | Error,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  // An error thrown after the response has already begun can't be answered:
  // res.status() would throw ERR_HTTP_HEADERS_SENT from inside the error
  // handler, which Express 5 has nowhere to route, so it shows up as an
  // unhandled rejection and shutdown()s the process. Hand it to Express's
  // default handler, which destroys the socket.
  if (res.headersSent) return _next(err)
  // The real error, for the admin metrics: the body below may mask it.
  if (res.locals) res.locals.error = err
  if (answeredAsSpecialError(err, req, res)) return

  const statusCode = (err as AppError).statusCode ?? 500
  logRequestError(statusCode, err, req)
  const isDev = process.env.NODE_ENV === "development"

  // Never leak internal error details (raw DB/driver messages, stack traces)
  // for server errors in production. Anything that isn't one of our own
  // AppError subclasses has no statusCode, so it falls through to 500 and
  // gets the generic message.
  // 503/507 raised as our own AppError ("upload slots busy", "photo storage
  // full") are deliberate, client-actionable answers, so they keep their message
  // and code like a 4xx does.
  const exposed =
    statusCode < 500 ||
    ((statusCode === 503 || statusCode === 507) &&
      (err as AppError).statusCode !== undefined)
  const safeMessage = exposed
    ? err.message
    : (isDev && err.message) || "Internal server error"

  const response: ErrorResponse = {
    success: false,
    error: safeMessage,
    reqId: req.reqId,
  }

  // Only our own errors have a code clients can act on. Driver codes
  // (ER_DUP_ENTRY, ...) are internal details and stay out of 5xx responses.
  if (exposed && (err as AppError).code)
    response.code = (err as AppError).code
  if (exposed && (err as AppError).details)
    response.details = (err as AppError).details
  if (isDev && err.stack) response.stack = err.stack

  res.status(statusCode).json(response)
}

/** The errors with a fixed answer of their own. True when one was sent. */
function answeredAsSpecialError(err: Error, req: Request, res: Response): boolean {
  // multer raises its own error class with no statusCode. The one a client can
  // fix is a file over the size limit.
  if (err.name === "MulterError") {
    const status = (err as { code?: string }).code === "LIMIT_FILE_SIZE" ? 413 : 400
    res.status(status).json({ success: false, error: err.message })
    return true
  }

  // A value that doesn't fit its column is a client that sent something out of
  // range: 400 wherever it happens, instead of a per-route bound check for
  // every string and DECIMAL column. 1406 = ER_DATA_TOO_LONG (string too long),
  // 1264 = ER_WARN_DATA_OUT_OF_RANGE and 1265 = WARN_DATA_TRUNCATED, which is
  // what a DECIMAL(10,3) answers to a weight of 1e9. The generic message is
  // deliberate: the driver's includes table and column names.
  if ([1406, 1264, 1265].includes((err as { errno?: number }).errno ?? 0)) {
    res.status(400).json({
      success: false,
      error: "Value out of range for its field",
      code: "VALUE_OUT_OF_RANGE",
    })
    return true
  }

  if (isDbUnavailableError(err)) {
    logger.error("Database unavailable:", {
      message: err.message,
      code: (err as { code?: string }).code,
      errno: (err as { errno?: number }).errno,
      path: req.path,
      method: req.method,
      reqId: req.reqId,
    })
    res.set("Retry-After", String(DB_RETRY_AFTER_S))
    res.status(503).json({
      success: false,
      error: "Server is busy, please retry shortly",
      code: "SERVICE_UNAVAILABLE",
      reqId: req.reqId,
    })
    return true
  }
  return false
}

function logRequestError(statusCode: number, err: Error, req: Request): void {
  // 4xx is the client being told something normal ("wrong password", "you have
  // no program yet"): one info line, not a multi-line warning that reads like
  // the server broke. The admin metrics page counts and groups them anyway.
  // Only 5xx means this server is broken, and its stack goes to the log in
  // every environment. The log is the operator's, and the response is
  // where production hides it.
  if (statusCode < 500) {
    const code = (err as AppError).code
    logger.info(
      `${statusCode} ${req.method} ${req.path}: ${err.message}${code ? " [" + code + "]" : ""} (reqId ${req.reqId})`,
    )
    return
  }
  logger.error("Server error:", {
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    reqId: req.reqId,
  })
}
