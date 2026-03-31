export interface TracerSpan {
  addAttributes(attributes: Record<string, unknown>): void;
  setStatus(status: 'ok' | 'error' | string, description?: string | null): void;
  recordException(exception: Error): void;
}

export interface TracerScope<TSpan extends TracerSpan = TracerSpan> {
  span: TSpan;
  close(): void;
}

export interface Tracer {
  startSpan(name: string): TracerScope;
}

export class NoOpSpan implements TracerSpan {
  addAttributes(_attributes: Record<string, unknown>): void {}

  setStatus(_status: 'ok' | 'error' | string, _description?: string | null): void {}

  recordException(_exception: Error): void {}
}

export class NoOpTracer implements Tracer {
  startSpan(_name: string): TracerScope<NoOpSpan> {
    return {
      span: new NoOpSpan(),
      close(): void {}
    };
  }
}

/**
 * OpenTelemetry span wrapper — port of Python's OpenTelemetrySpan.
 *
 * Wraps an OTEL Span object (from @opentelemetry/api) and silently
 * catches all tracing errors to avoid disrupting the main application.
 *
 * Usage:
 *   import { trace } from '@opentelemetry/api';
 *   const tracer = new OpenTelemetryTracer(trace.getTracer('graphiti'));
 */
export class OpenTelemetrySpan implements TracerSpan {
  constructor(private readonly _span: {
    setAttribute(key: string, value: string | number | boolean): void;
    setAttributes?(attributes: Record<string, string | number | boolean>): void;
    setStatus(status: { code: number; message?: string }): void;
    recordException(exception: Error): void;
    end(): void;
  }) {}

  addAttributes(attributes: Record<string, unknown>): void {
    try {
      for (const [key, value] of Object.entries(attributes)) {
        if (value === null || value === undefined) continue;
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          this._span.setAttribute(key, value);
        } else {
          this._span.setAttribute(key, String(value));
        }
      }
    } catch {
      // Silently ignore tracing errors
    }
  }

  setStatus(status: 'ok' | 'error' | string, description?: string | null): void {
    try {
      // OTEL StatusCode: UNSET=0, OK=1, ERROR=2
      const code = status === 'error' ? 2 : status === 'ok' ? 1 : 0;
      const statusObj: { code: number; message?: string } = { code };
      if (description != null) {
        statusObj.message = description;
      }
      this._span.setStatus(statusObj);
    } catch {
      // Silently ignore tracing errors
    }
  }

  recordException(exception: Error): void {
    try {
      this._span.recordException(exception);
    } catch {
      // Silently ignore tracing errors
    }
  }
}

/**
 * OpenTelemetry tracer wrapper — port of Python's OpenTelemetryTracer.
 *
 * Wraps an OTEL Tracer (from @opentelemetry/api) with configurable span
 * name prefix. Falls back to NoOp on any error.
 */
export class OpenTelemetryTracer implements Tracer {
  private readonly _tracer: {
    startSpan(name: string): {
      setAttribute(key: string, value: string | number | boolean): void;
      setAttributes?(attributes: Record<string, string | number | boolean>): void;
      setStatus(status: { code: number; message?: string }): void;
      recordException(exception: Error): void;
      end(): void;
    };
  };
  private readonly _prefix: string;

  constructor(
    otelTracer: {
      startSpan(name: string): {
        setAttribute(key: string, value: string | number | boolean): void;
        setAttributes?(attributes: Record<string, string | number | boolean>): void;
        setStatus(status: { code: number; message?: string }): void;
        recordException(exception: Error): void;
        end(): void;
      };
    },
    spanPrefix = 'graphiti'
  ) {
    this._tracer = otelTracer;
    this._prefix = spanPrefix.replace(/\.$/, '');
  }

  startSpan(name: string): TracerScope<OpenTelemetrySpan> {
    try {
      const fullName = `${this._prefix}.${name}`;
      const otelSpan = this._tracer.startSpan(fullName);
      const wrappedSpan = new OpenTelemetrySpan(otelSpan);

      return {
        span: wrappedSpan,
        close(): void {
          try {
            otelSpan.end();
          } catch {
            // Silently ignore
          }
        }
      };
    } catch {
      // If tracing fails, return a no-op scope
      return {
        span: new OpenTelemetrySpan({
          setAttribute() {},
          setStatus() {},
          recordException() {},
          end() {}
        }),
        close(): void {}
      };
    }
  }
}

export function createTracer(otelTracer?: Tracer | null): Tracer {
  return otelTracer ?? new NoOpTracer();
}
