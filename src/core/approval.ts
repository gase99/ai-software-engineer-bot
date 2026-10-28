import type { Store } from '../db/store.js';
import { hmacSign, randomToken, safeEqual, sha256Hex } from '../util/crypto.js';

export interface ApprovalVerification {
  ok: boolean;
  reason?: string;
  approvalId?: string;
}

/**
 * Approval workflow.
 *
 * An approval is only valid when ALL of these hold:
 *  - the callback token is correctly signed with APPROVAL_SECRET
 *  - it matches the stored hash for (request_id, plan_version)
 *  - it has not expired
 *  - the decision was not already taken
 *
 * Repository content, model output and free text ("باشه", "ممنون") can never
 * satisfy these conditions.
 */
export class ApprovalService {
  constructor(
    private readonly store: Store,
    private readonly secret: string,
    private readonly ttlMinutes = 30,
  ) {}

  async issue(requestId: string, planVersion: number): Promise<string> {
    const nonce = randomToken(18);
    const signature = await hmacSign(this.secret, `${requestId}.${planVersion}.${nonce}`);
    const token = `${nonce}.${signature}`;
    const expiresAt = new Date(Date.now() + this.ttlMinutes * 60_000).toISOString();
    await this.store.createApproval(requestId, planVersion, await sha256Hex(token), expiresAt);
    return token;
  }

  async verify(requestId: string, planVersion: number, token: string): Promise<ApprovalVerification> {
    if (!token || token.split('.').length !== 2) return { ok: false, reason: 'قالب تأیید نامعتبر است' };
    const [nonce, signature] = token.split('.') as [string, string];
    const expected = await hmacSign(this.secret, `${requestId}.${planVersion}.${nonce}`);
    if (!(await safeEqual(signature, expected))) return { ok: false, reason: 'امضای تأیید نامعتبر است' };

    const approval = await this.store.getApproval(requestId, planVersion);
    if (!approval) return { ok: false, reason: 'هیچ درخواست تأیید فعالی برای این نسخه طرح نیست' };
    if (approval.token_hash !== (await sha256Hex(token))) return { ok: false, reason: 'این تأیید متعلق به این درخواست نیست' };
    if (approval.status !== 'pending') return { ok: false, reason: `وضعیت این تأیید «${approval.status}» است` };
    if (new Date(approval.expires_at).getTime() < Date.now()) {
      await this.store.decideApproval(approval.id, 'expired', 'system');
      return { ok: false, reason: 'زمان این تأیید تمام شده؛ لطفاً دوباره درخواست بدهید' };
    }
    return { ok: true, approvalId: approval.id };
  }

  async approve(requestId: string, planVersion: number, token: string, actor: string): Promise<ApprovalVerification> {
    const verification = await this.verify(requestId, planVersion, token);
    if (!verification.ok || !verification.approvalId) return verification;
    await this.store.decideApproval(verification.approvalId, 'approved', actor);
    return verification;
  }

  async reject(requestId: string, planVersion: number, token: string, actor: string): Promise<ApprovalVerification> {
    const verification = await this.verify(requestId, planVersion, token);
    if (!verification.ok || !verification.approvalId) return verification;
    await this.store.decideApproval(verification.approvalId, 'rejected', actor);
    return verification;
  }
}
