import { ApplicationError, ERROR_STATUS, appError } from '../shared/errors.js';

const BODY_PARSER_CLIENT_ERRORS = new Set([
  'entity.parse.failed',
  'entity.too.large',
  'charset.unsupported',
  'encoding.unsupported',
]);

export function notFoundHandler(_request, _response, next) {
  next(appError('resource_not_found', 'The requested resource was not found'));
}

export function createErrorHandler({ logger = console } = {}) {
  return function errorHandler(error, _request, response, _next) {
    let publicError = error;
    if (BODY_PARSER_CLIENT_ERRORS.has(error?.type)) {
      publicError = appError('invalid_request', 'The request is invalid');
    }

    if (!(publicError instanceof ApplicationError) || !ERROR_STATUS[publicError.code]) {
      logger.error?.(error);
      publicError = appError('internal_error', 'An unexpected error occurred');
    } else if (publicError.code === 'internal_error') {
      logger.error?.(publicError.cause ?? publicError);
    }

    const body = {
      error: {
        code: publicError.code,
        message: publicError.message,
      },
    };
    if (publicError.details !== undefined) body.error.details = publicError.details;
    response.status(ERROR_STATUS[publicError.code]).json(body);
  };
}
