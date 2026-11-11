import { GEMINI_MODEL_ID, GEMINI_DIMENSIONS, GEMINI_TASK_TYPES } from './providers';

/** Derived from the same constants used for generation, never caller settings. */
export function embeddingCapabilities() {
  return {
    model: GEMINI_MODEL_ID,
    dimensions: GEMINI_DIMENSIONS,
    task_types: [...GEMINI_TASK_TYPES],
  };
}
