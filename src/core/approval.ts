import type { Store } from '../db/store.js';
import { hmacSignShort, randomToken, safeEqual, sha256Hex } from '../util/crypto.js';

export interface ApprovalVerification {
  ok: boolean;
  reason?: string;
  approvalId?: string;
}

export class ApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalError';
  }
}

/**
 * Approval workflow.
 *
 * An approval is only valid when ALL of these hold:
 *  - the callback token is correctly signed with APPROVAL_SECRET
 *  - it matches the stored hash for (request_id, plan_version)
 *  - it belongs to the current plan and a request awaiting approval
 *  - it has not expired
 *  - the decision was not already taken
 *
 * Tokens are compact enough for Telegram's 64-byte callback_data limit while
 * retaining a 72-bit nonce and a truncated 132-bit HMAC signature.
 */
export class ApprovalService {
  constructor(
    private readonly store: Store,
    private readonly secret: string,
    private readonly ttlMinutes = 30,
  ) {}

  async issue(requestId: string, planVersion: number): Promise<string> {
    // A newly rendered plan message supersedes every older pending button for
    // this request. This also makes /resume safe when it is used repeatedly.
    await this.store.supersedePendingApprovals(requestId);

    const nonce = randomToken(9);
    const signature = await hmacSignShort(this.secret, `${requestId}.${planVersion}.${nonce}`);
    const token = `${nonce}.${signature}`;
    const expiresAt = new Date(Date.now() + this.ttlMinutes * 60_000).toISOString();
    await this.store.createApproval(requestId, planVersion, await sha256Hex(token), expiresAt);
    return token;
  }

  async verify(requestId: string, planVersion: number, token: string): Promise<ApprovalVerification> {
    if (!token || token.split('.').length !== 2) return { ok: false, reason: 'قالب تأیید نامعتبر است' };
    const [nonce, signature] = token.split('.') as [string, string];
    if (!nonce || !signature) return { ok: false, reason: 'قالب تأیید نامعتبر است' };

    const expected = await hmacSignShort(this.secret, `${requestId}.${planVersion}.${nonce}`);
    if (!(await safeEqual(signature, expected))) return { ok: false, reason: 'امضای تأیید نامعتبر است' };

    const request = await this.store.getRequest(requestId);
    if (!request || request.current_plan_version !== planVersion || request.status !== 'awaiting_approval') {
      return { ok: false, reason: 'این تأیید مربوط به نسخه فعلی درخواست نیست؛ طرح تازه را بررسی کنید' };
    }

    const approval = await this.store.getApproval(requestId, planVersion);
    if (!approval) return { ok: false, reason: 'هیچ درخواست تأیید فعالی برای این نسخه طرح نیست' };
    if (approval.token_hash !== (await sha256Hex(token))) return { ok: false, reason: 'این تأیید متعلق به این درخواست نیست' };
    if (approval.status !== 'pending') return { ok: false, reason: `وضعیت این تأیید «${approval.status}» است` };
    if (new Date(approval.expires_at).getTime() <= Date.now()) {
      await this.store.decideApproval(approval.id, 'expired', 'system');
      return { ok: false, reason: 'زمان این تأیید تمام شده؛ لطفاً دوباره درخواست بدهید' };
    }
    return { ok: true, approvalId: approval.id };
  }

  /** Internal execution gate: verify the stored decision and its owner again. */
  async verifyApproved(requestId: string, planVersion: number): Promise<ApprovalVerification> {
    const request = await this.store.getRequest(requestId);
    if (!request || request.current_plan_version !== planVersion || !['approved', 'executing'].includes(request.status)) {
      return { ok: false, reason: 'تأیید، وضعیت درخواست یا نسخه طرح برای اجرا معتبر نیست' };
    }
    const approval = await this.store.getApproval(requestId, planVersion);
    if (!approval || approval.status !== 'approved' || !approval.actor || approval.actor === 'system') {
      return { ok: false, reason: 'تأیید مالک برای این نسخه طرح ثبت نشده است' };
    }
    if (new Date(approval.expires_at).getTime() <= Date.now()) {
      return { ok: false, reason: 'زمان اجرای این تأیید تمام شده؛ تأیید تازه لازم است' };
    }
    return { ok: true, approvalId: approval.id };
  }

  async approve(requestId: string, planVersion: number, token: string, actor: string): Promise<ApprovalVerification> {
    const verification = await this.verify(requestId, planVersion, token);
    if (!verification.ok || !verification.approvalId) return verification;
    const consumed = await this.store.decideApproval(verification.approvalId, 'approved', actor);
    if (!consumed) return { ok: false, reason: 'این تأیید قبلاً استفاده یا باطل شده است' };
    return verification;
  }

  async reject(requestId: string, planVersion: number, token: string, actor: string): Promise<ApprovalVerification> {
    const verification = await this.verify(requestId, planVersion, token);
    if (!verification.ok || !verification.approvalId) return verification;
    const consumed = await this.store.decideApproval(verification.approvalId, 'rejected', actor);
    if (!consumed) return { ok: false, reason: 'این تأیید قبلاً استفاده یا باطل شده است' };
    return verification;
  }
}
