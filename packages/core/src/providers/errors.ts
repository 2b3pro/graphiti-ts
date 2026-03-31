import { GraphitiError } from '@graphiti/shared';

export class RateLimitError extends GraphitiError {
  constructor(message = 'Rate limit exceeded. Please try again later.') {
    super(message);
  }
}

export class RefusalError extends GraphitiError {
  constructor(message: string) {
    super(message);
  }
}

export class EmptyResponseError extends GraphitiError {
  constructor(message = 'LLM returned an empty response.') {
    super(message);
  }
}
