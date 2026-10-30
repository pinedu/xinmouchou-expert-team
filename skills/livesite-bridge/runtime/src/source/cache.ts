// 源缓存：bundle 清单（manifest）+ 契约（contract.json）落盘与失效检测。
// 失效触发器：① 入口 script 清单 hash 变化；② 内联 runtime hash 变化；③ 周期全量重抓。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { BundleMeta, RuntimeContract } from '../contract/types.js';

export interface CacheState {
  dir: string;
  manifestPath: string;
  contractPath: string;
}

export interface StalenessCheck {
  stale: boolean;
  reason: string | null;
  /** 上次自举时间（ISO） */
  generatedAt: string | null;
}

export class SourceCache {
  constructor(private readonly dir: string) {}

  private manifest(): string {
    return path.join(this.dir, 'manifest.json');
  }
  private contract(): string {
    return path.join(this.dir, 'contract.json');
  }

  /** 读已缓存 manifest（bundle 清单） */
  readManifest(): BundleMeta[] | null {
    try {
      const raw = fs.readFileSync(this.manifest(), 'utf8');
      return JSON.parse(raw) as BundleMeta[];
    } catch {
      return null;
    }
  }

  readContract(): RuntimeContract | null {
    try {
      const raw = fs.readFileSync(this.contract(), 'utf8');
      return JSON.parse(raw) as RuntimeContract;
    } catch {
      return null;
    }
  }

  writeManifest(bundles: BundleMeta[]): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.manifest(), JSON.stringify(bundles, null, 2));
  }

  writeContract(c: RuntimeContract): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.contract(), JSON.stringify(c, null, 2));
  }

  /**
   * 失效检测：比较「当前拉取的入口清单+runtime 指纹」与缓存。
   * 只要入口 script 清单或内联 runtime 的 hash 变了 → stale=true，触发重新自举。
   * 站内 chunk 单独变更（入口未变）检测不到 → 由周期全量重抓兜底（sourceRefreshMin）。
   */
  checkStale(currentFingerprint: { entryListHash: string; runtimeHash: string; nowEpochMs: number }, refreshMin: number): StalenessCheck {
    const c = this.readContract();
    if (!c) return { stale: true, reason: '无已缓存契约', generatedAt: null };
    const generatedAt = c.generatedAt ?? null;
    const lastEpoch = generatedAt ? Date.parse(generatedAt) : 0;
    const maxAgeMs = refreshMin * 60_000;
    if (maxAgeMs > 0 && Number.isFinite(lastEpoch) && currentFingerprint.nowEpochMs - lastEpoch > maxAgeMs) {
      return { stale: true, reason: `超过周期重抓间隔（${refreshMin} 分钟）`, generatedAt };
    }
    // 入口指纹存于契约的 bundles 里（入口 bundle + inline-runtime 的 hash）
    const entryNames = new Set(c.bundles.map((b) => b.name));
    const runtime = c.bundles.find((b) => b.name.startsWith('inline-runtime-'));
    const fpMismatch = runtime ? runtime.hash !== currentFingerprint.runtimeHash : true;
    if (fpMismatch || entryNames.size === 0) {
      return { stale: true, reason: '入口/内联 runtime 指纹变化（站点已发新版）', generatedAt };
    }
    return { stale: false, reason: null, generatedAt };
  }
}

/** 入口 script 清单指纹（用于失效检测） */
export function entryListFingerprint(scripts: string[]): string {
  return createHash('sha1').update(scripts.join('\n')).digest('hex').slice(0, 12);
}
