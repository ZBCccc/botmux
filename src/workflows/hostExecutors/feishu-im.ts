import type { ProviderReconciler } from '../resume.js';
import { feishuReplyReconciler } from './feishu-reply.js';
import { feishuSendReconciler } from './feishu-send.js';

/**
 * Single Feishu IM provider reconciler.
 *
 * `effectAttempted.provider` is intentionally `feishu-im` for both
 * `feishu-send` and `feishu-reply` because Feishu's idempotency surface
 * is the IM uuid field.  The executor id identifies the author-facing
 * operation; resume only sees the provider, so it dispatches by the
 * recovered effect input shape.
 */
export const feishuImReconciler: ProviderReconciler = {
  provider: 'feishu-im',
  requiresEffectInput: true,

  async idempotentSubmit(idempotencyKey, input) {
    if (isRecord(input) && Object.prototype.hasOwnProperty.call(input, 'rootMessageId')) {
      return feishuReplyReconciler.idempotentSubmit!(idempotencyKey, input);
    }
    if (isRecord(input) && Object.prototype.hasOwnProperty.call(input, 'chatId')) {
      return feishuSendReconciler.idempotentSubmit!(idempotencyKey, input);
    }
    return {
      ok: false,
      errorCode: 'InputValidationFailed',
      errorClass: 'manual',
      errorMessage:
        "Feishu IM effect input must include either 'chatId' (send) or 'rootMessageId' (reply)",
      evidence: { source: 'idempotentSubmit', reason: 'unknown_feishu_im_input' },
    };
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
