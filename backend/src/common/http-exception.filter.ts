import {ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger} from '@nestjs/common';
import {FastifyReply, FastifyRequest} from 'fastify';

@Catch()
export class StructuredExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(StructuredExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const request = host.switchToHttp().getRequest<FastifyRequest>();
    const response = host.switchToHttp().getResponse<FastifyReply>();
    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const raw = exception instanceof HttpException ? exception.getResponse() : null;
    const details = typeof raw === 'object' && raw !== null && 'message' in raw ? (raw as {message: unknown}).message : undefined;
    const message = typeof raw === 'string'
      ? raw
      : typeof details === 'string'
        ? details
      : exception instanceof Error && status >= 500
        ? 'Internal server error.'
        : 'Request validation failed.';
    if (status >= 500) this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    const code = status === 400 ? 'VALIDATION_ERROR'
      : status === 401 ? 'UNAUTHORIZED'
        : status === 404 ? 'NOT_FOUND'
          : status >= 500 ? 'INTERNAL_ERROR'
            : 'REQUEST_FAILED';
    response.status(status).send({
      error: {
        code,
        message,
        ...(Array.isArray(details) ? {details} : {})
      },
      timestamp: new Date().toISOString(),
      path: request.url
    });
  }
}
