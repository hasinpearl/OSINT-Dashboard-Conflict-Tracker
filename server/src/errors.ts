import type { Context } from "hono";

// Generate an 8-character hex request ID
export function generateRequestId(): string {
  return Math.random().toString(16).slice(2, 10);
}

// Error codes catalogue with bilingual messages
export const ERROR_CODES = {
  gateway_not_configured: {
    status: 503,
    message: "بوابة الذكاء غير مهيأة | AI gateway not configured",
    retryable: false,
  },
  ai_gateway_error: {
    status: 502,
    message: "خطأ في بوابة الذكاء | AI gateway error",
    retryable: true,
  },
  firecrawl_error: {
    status: 502,
    message: "فشل في بحث Firecrawl | Firecrawl search failed",
    retryable: true,
  },
  ai_gateway_key_missing: {
    status: 503,
    message: "مفتاح بوابة الذكاء مفقود | AI gateway key missing",
    retryable: false,
  },
  telegram_fetch_failed: {
    status: 502,
    message: "فشل في جلب بيانات تيليغرام | Telegram fetch failed",
    retryable: true,
  },
  translate_failed: {
    status: 502,
    message: "فشل في الترجمة | Translation failed",
    retryable: true,
  },
  budget_exhausted: {
    status: 429,
    message: "تم استنفاد الميزانية | Budget exhausted",
    retryable: false,
  },
  not_found: {
    status: 404,
    message: "غير موجود | Not found",
    retryable: false,
  },
  internal_error: {
    status: 500,
    message: "حدث خطأ غير متوقع | Internal error",
    retryable: false,
  },
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

// Custom error class for application errors
export class AppError extends Error {
  code: ErrorCode;
  status: number;
  retryable: boolean;
  extraDetail?: string;

  constructor(code: ErrorCode, extraDetail?: string) {
    const errorInfo = ERROR_CODES[code];
    const message = errorInfo.message;
    
    super(message);
    
    this.code = code;
    this.status = errorInfo.status;
    this.retryable = errorInfo.retryable;
    this.extraDetail = extraDetail;
    
    // Ensure proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

// Enhanced error handler for Hono
export function enhancedOnError(err: Error, c: Context) {
  const requestId = generateRequestId();
  
  // If it's our custom AppError
  if (err instanceof AppError) {
    // Log structured error information
    console.error(JSON.stringify({
      error_code: err.code,
      request_id: requestId,
      retryable: err.retryable,
      path: c.req.path,
      extra_detail: err.extraDetail,
    }));
    
    // Return RFC 7807 compliant error response
    return c.json({
      type: `https://osint.local/errors/${err.code}`,
      title: err.message,
      status: err.status,
      code: err.code,
      instance: `req_${requestId}`,
      ...(err.extraDetail ? { detail: err.extraDetail } : {}),
    }, err.status as any);
  }
  
  // For unexpected errors, log with full stack trace
  console.error(JSON.stringify({
    error_code: "internal_error",
    request_id: requestId,
    retryable: false,
    path: c.req.path,
    error_message: err.message,
    stack: err.stack,
  }));
  
  // Return generic internal error response
  const internalError = ERROR_CODES.internal_error;
  return c.json({
    type: "https://osint.local/errors/internal_error",
    title: internalError.message,
    status: internalError.status,
    code: "internal_error",
    instance: `req_${requestId}`,
  }, internalError.status as any);
}