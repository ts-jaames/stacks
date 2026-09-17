/**
 * Reverberation (Propagation) Utilities for Stacks
 * 
 * When a Source changes, downstream Syntheses and Artifacts that depend on it
 * should be recalibrated. This module provides:
 * - Token rendering: Replace {{TOKEN}} placeholders with fact values
 * - Diff computation: Track what changed between versions
 * - Propagation logic: Identify and update dependent items
 * 
 * No AI - uses deterministic token substitution for demo purposes.
 */

import type { DiffSummary, Fieldbook, Source, Synthesis, Artifact, RecalcStatus } from "./db/types";

/**
 * Render a template string by replacing {{TOKEN}} placeholders with fact values
 * 
 * @param template - Content with {{TOKEN}} placeholders
 * @param facts - Key-value pairs for token substitution
 * @returns Rendered content with tokens replaced
 */
export function renderTemplate(template: string, facts: Record<string, string>): string {
  if (!template) return template;
  
  // Match {{TOKEN_NAME}} patterns
  return template.replace(/\{\{(\w+)\}\}/g, (match, token) => {
    if (token in facts) {
      return facts[token];
    }
    // Leave unmatched tokens as-is (or could use "(missing)")
    return match;
  });
}

/**
 * Extract all token names from a template string
 * 
 * @param template - Content with {{TOKEN}} placeholders
 * @returns Array of unique token names
 */
export function extractTokens(template: string): string[] {
  if (!template) return [];
  
  const matches = template.match(/\{\{(\w+)\}\}/g);
  if (!matches) return [];
  
  // Extract token names and dedupe
  const tokens = matches.map(m => m.slice(2, -2));
  return [...new Set(tokens)];
}

/**
 * Check if a template contains any tokens
 */
export function hasTokens(template: string): boolean {
  if (!template) return false;
  return /\{\{(\w+)\}\}/.test(template);
}

/**
 * Compute a simple diff between two strings
 * Finds the first and last positions where they differ and extracts the changed segments.
 * 
 * @param prev - Previous content
 * @param next - New content
 * @returns DiffSummary or null if no change
 */
export function computeDiff(prev: string, next: string): DiffSummary | null {
  if (prev === next) return null;
  
  // Find first differing character
  let start = 0;
  const minLen = Math.min(prev.length, next.length);
  while (start < minLen && prev[start] === next[start]) {
    start++;
  }
  
  // Find last differing character (from end)
  let prevEnd = prev.length;
  let nextEnd = next.length;
  while (prevEnd > start && nextEnd > start && prev[prevEnd - 1] === next[nextEnd - 1]) {
    prevEnd--;
    nextEnd--;
  }
  
  // Extract the changed portions
  const before = prev.slice(start, prevEnd);
  const after = next.slice(start, nextEnd);
  
  // Generate human-friendly message
  let message: string;
  if (before && after) {
    // Look for simple value changes like "30%" -> "40%"
    const beforeTrimmed = before.trim();
    const afterTrimmed = after.trim();
    if (beforeTrimmed.length < 50 && afterTrimmed.length < 50) {
      message = `Updated from "${beforeTrimmed}" to "${afterTrimmed}" due to Source change`;
    } else {
      message = "Content updated due to upstream Source change";
    }
  } else if (!before && after) {
    message = "Content added due to upstream Source change";
  } else if (before && !after) {
    message = "Content removed due to upstream Source change";
  } else {
    message = "Content updated due to upstream Source change";
  }
  
  return {
    before,
    after,
    start,
    end: prevEnd,
    message,
  };
}

/**
 * Result of a propagation operation
 */
export interface PropagationResult {
  updatedSourceIds: string[];
  updatedSynthesisIds: string[];
  updatedArtifactIds: string[];
  fieldbook: Fieldbook;
}

/**
 * Extract plain text from TipTap JSON or return raw string.
 */
function extractText(content: string): string {
  try {
    const parsed = JSON.parse(content);
    if (parsed.content && Array.isArray(parsed.content)) {
      const parts: string[] = [];
      const walk = (nodes: unknown[]) => {
        for (const node of nodes) {
          const n = node as Record<string, unknown>;
          if (typeof n.text === "string") parts.push(n.text);
          if (Array.isArray(n.content)) walk(n.content);
        }
      };
      walk(parsed.content);
      return parts.join(" ");
    }
    return content;
  } catch {
    return content;
  }
}

/**
 * Build a content-aware diff by comparing the previous and current source text.
 * Produces a meaningful `before`/`after` snippet from the actual source edit
 * so downstream banners show what changed in the evidence.
 */
function buildSourceChangeDiff(
  prevSourceContent: string | undefined,
  currentSourceContent: string,
  sourceTitle: string,
  sourceId: string,
): DiffSummary {
  if (!prevSourceContent) {
    const snippet = extractText(currentSourceContent).slice(0, 150);
    return {
      before: "",
      after: "",
      start: 0,
      end: 0,
      message: `"${sourceTitle}" was edited. Review this content to ensure it still reflects the latest evidence.`,
      triggeredBySourceId: sourceId,
      triggeredBySourceTitle: sourceTitle,
      sourceChangeSnippet: snippet || undefined,
    };
  }

  const prevText = extractText(prevSourceContent);
  const currText = extractText(currentSourceContent);

  if (prevText === currText) {
    return {
      before: "",
      after: "",
      start: 0,
      end: 0,
      message: `"${sourceTitle}" was updated. Review this content for accuracy.`,
      triggeredBySourceId: sourceId,
      triggeredBySourceTitle: sourceTitle,
      sourceChangeSnippet: currText.slice(0, 150) || undefined,
    };
  }

  // Find a short differing segment for the banner's before/after display
  const raw = computeDiff(prevText, currText);
  const before = raw?.before?.trim().slice(0, 120) || "";
  const after = raw?.after?.trim().slice(0, 120) || "";

  let message: string;
  if (before && after && before.length < 80 && after.length < 80) {
    message = `"${sourceTitle}" changed: "${before}" → "${after}". Review downstream content.`;
  } else {
    message = `"${sourceTitle}" was edited. Review this content to ensure it still reflects the latest evidence.`;
  }

  return {
    before,
    after,
    start: raw?.start ?? 0,
    end: raw?.end ?? 0,
    message,
    triggeredBySourceId: sourceId,
    triggeredBySourceTitle: sourceTitle,
    sourceChangeSnippet: currText.slice(0, 150) || undefined,
  };
}

/**
 * Degrade a confidence score when upstream evidence changes.
 * Applies a 15% penalty with a floor of 20.
 */
function degradeConfidence(score: number | undefined): number | undefined {
  if (score == null) return score;
  return Math.max(20, Math.round(score * 0.85));
}

/**
 * Recompute both confidence fields when upstream evidence changes.
 *
 * A human override records a considered judgement about the evidence as it
 * stood when the override was set. Once that evidence moves, the judgement is
 * stale — and because display resolves as `humanConfidenceOverride ??
 * confidenceScore`, leaving the override in place would keep showing the old
 * hand-set number indefinitely while the evidence beneath it had shifted,
 * masking the degradation entirely.
 *
 * So the override is cleared and the degraded score becomes visible again. The
 * item is simultaneously marked `recalibrating` with a `lastDiff`, so the human
 * can review what changed and re-assert an override if they still stand by it.
 */
function decayConfidence(item: {
  confidenceScore?: number;
  humanConfidenceOverride?: number | null;
}): { confidenceScore?: number; humanConfidenceOverride: number | null } {
  return {
    confidenceScore: degradeConfidence(item.confidenceScore),
    humanConfidenceOverride: null,
  };
}

/**
 * Propagate changes from a Source to all dependent Syntheses and Artifacts.
 *
 * Content-aware: when prevSourceContent is provided, computes a real
 * source-level diff that downstream banners display. Also degrades
 * confidence scores and clears human overrides on affected items.
 */
export function propagateFromSource(
  fieldbook: Fieldbook,
  sourceId: string,
  prevSourceContent?: string,
): PropagationResult {
  const facts = fieldbook.facts || {};
  const now = new Date().toISOString();

  const updatedSourceIds: string[] = [];
  const updatedSynthesisIds: string[] = [];
  const updatedArtifactIds: string[] = [];

  const triggeringSource = fieldbook.sources.find(s => s.id === sourceId);
  const sourceTitle = triggeringSource?.title || "Unknown Source";
  const currentSourceContent = triggeringSource?.content || "";

  // Pre-compute the source-level diff once (reused for every downstream item)
  const sourceDiff = buildSourceChangeDiff(
    prevSourceContent,
    currentSourceContent,
    sourceTitle,
    sourceId,
  );

  // Create a mutable copy of the fieldbook
  const updated: Fieldbook = {
    ...fieldbook,
    sources: fieldbook.sources.map(s => ({ ...s })),
    syntheses: fieldbook.syntheses.map(s => ({ ...s })),
    artifacts: fieldbook.artifacts.map(a => ({ ...a })),
  };

  // 1. Update the source itself (token re-render path only)
  const sourceIdx = updated.sources.findIndex(s => s.id === sourceId);
  if (sourceIdx !== -1) {
    const source = updated.sources[sourceIdx];
    const template = source.contentTemplate || source.content;

    if (hasTokens(template)) {
      const prevRendered = source.contentRendered || source.content;
      const newRendered = renderTemplate(template, facts);

      if (newRendered !== prevRendered) {
        const tokenDiff = computeDiff(prevRendered, newRendered);
        updated.sources[sourceIdx] = {
          ...source,
          contentTemplate: template,
          contentRendered: newRendered,
          content: newRendered,
          lastRenderedAt: now,
          recalcStatus: "recalibrating",
          lastDiff: tokenDiff ? {
            ...tokenDiff,
            triggeredBySourceId: sourceId,
            triggeredBySourceTitle: sourceTitle,
          } : null,
        };
        updatedSourceIds.push(sourceId);
      }
    }
  }

  // 2. Find and update dependent Syntheses
  updated.syntheses.forEach((synthesis, idx) => {
    if (!synthesis.derivedFrom?.includes(sourceId)) return;

    const template = synthesis.contentTemplate || synthesis.content;
    let lastDiff: DiffSummary = sourceDiff;

    // Token path: if template tokens produce a content change, use that diff instead
    if (hasTokens(template)) {
      const prevRendered = synthesis.contentRendered || synthesis.content;
      const newRendered = renderTemplate(template, facts);

      if (newRendered !== prevRendered) {
        const tokenDiff = computeDiff(prevRendered, newRendered);
        if (tokenDiff) {
          lastDiff = {
            ...tokenDiff,
            triggeredBySourceId: sourceId,
            triggeredBySourceTitle: sourceTitle,
            sourceChangeSnippet: sourceDiff.sourceChangeSnippet,
          };
        }
        updated.syntheses[idx] = {
          ...synthesis,
          contentTemplate: template,
          contentRendered: newRendered,
          content: newRendered,
          lastRenderedAt: now,
          recalcStatus: "recalibrating",
          lastDiff,
          ...decayConfidence(synthesis),
        };
        updatedSynthesisIds.push(synthesis.id);
        return;
      }
    }

    // Non-token or unchanged-token path: use the source-level diff
    updated.syntheses[idx] = {
      ...synthesis,
      recalcStatus: "recalibrating",
      lastRenderedAt: now,
      lastDiff,
      ...decayConfidence(synthesis),
    };
    updatedSynthesisIds.push(synthesis.id);
  });

  // 3. Find and update dependent Artifacts
  const affectedSynthesisSet = new Set(updatedSynthesisIds);

  updated.artifacts.forEach((artifact, idx) => {
    const informedBySource = artifact.informedBy?.includes(sourceId);
    const informedByAffectedSynthesis = artifact.informedBy?.some(id =>
      affectedSynthesisSet.has(id) ||
      updated.syntheses.some(s => s.id === id && s.derivedFrom?.includes(sourceId))
    );

    if (!informedBySource && !informedByAffectedSynthesis) return;

    const template = artifact.contentTemplate || artifact.content;
    let lastDiff: DiffSummary = sourceDiff;

    if (hasTokens(template)) {
      const prevRendered = artifact.contentRendered || artifact.content;
      const newRendered = renderTemplate(template, facts);

      if (newRendered !== prevRendered) {
        const tokenDiff = computeDiff(prevRendered, newRendered);
        if (tokenDiff) {
          lastDiff = {
            ...tokenDiff,
            triggeredBySourceId: sourceId,
            triggeredBySourceTitle: sourceTitle,
            sourceChangeSnippet: sourceDiff.sourceChangeSnippet,
          };
        }
        updated.artifacts[idx] = {
          ...artifact,
          contentTemplate: template,
          contentRendered: newRendered,
          content: newRendered,
          lastRenderedAt: now,
          recalcStatus: "recalibrating",
          lastDiff,
          ...decayConfidence(artifact),
        };
        updatedArtifactIds.push(artifact.id);
        return;
      }
    }

    updated.artifacts[idx] = {
      ...artifact,
      recalcStatus: "recalibrating",
      lastRenderedAt: now,
      lastDiff,
      ...decayConfidence(artifact),
    };
    updatedArtifactIds.push(artifact.id);
  });

  return {
    updatedSourceIds,
    updatedSynthesisIds,
    updatedArtifactIds,
    fieldbook: updated,
  };
}

/**
 * Mark all recalibrating items as calibrated
 * Call this after the recalibration animation completes
 */
export function markCalibrated(fieldbook: Fieldbook): Fieldbook {
  return {
    ...fieldbook,
    sources: fieldbook.sources.map(s => 
      s.recalcStatus === "recalibrating" ? { ...s, recalcStatus: "calibrated" as RecalcStatus } : s
    ),
    syntheses: fieldbook.syntheses.map(s => 
      s.recalcStatus === "recalibrating" ? { ...s, recalcStatus: "calibrated" as RecalcStatus } : s
    ),
    artifacts: fieldbook.artifacts.map(a => 
      a.recalcStatus === "recalibrating" ? { ...a, recalcStatus: "calibrated" as RecalcStatus } : a
    ),
  };
}

/**
 * Reset all items to idle state
 * Call this after showing the calibrated badge
 */
export function markIdle(fieldbook: Fieldbook): Fieldbook {
  return {
    ...fieldbook,
    sources: fieldbook.sources.map(s => 
      s.recalcStatus === "calibrated" ? { ...s, recalcStatus: "idle" as RecalcStatus } : s
    ),
    syntheses: fieldbook.syntheses.map(s => 
      s.recalcStatus === "calibrated" ? { ...s, recalcStatus: "idle" as RecalcStatus } : s
    ),
    artifacts: fieldbook.artifacts.map(a => 
      a.recalcStatus === "calibrated" ? { ...a, recalcStatus: "idle" as RecalcStatus } : a
    ),
  };
}

/**
 * Initialize contentRendered for all items that have templates but no rendered content
 * Call on app startup to ensure all content is properly rendered
 */
export function initializeRenderedContent(fieldbook: Fieldbook): Fieldbook {
  const facts = fieldbook.facts || {};
  const now = new Date().toISOString();
  
  return {
    ...fieldbook,
    sources: fieldbook.sources.map(s => {
      if (s.contentTemplate && !s.contentRendered) {
        return {
          ...s,
          contentRendered: renderTemplate(s.contentTemplate, facts),
          content: renderTemplate(s.contentTemplate, facts),
          lastRenderedAt: now,
          recalcStatus: "idle" as RecalcStatus,
        };
      }
      return s;
    }),
    syntheses: fieldbook.syntheses.map(s => {
      if (s.contentTemplate && !s.contentRendered) {
        return {
          ...s,
          contentRendered: renderTemplate(s.contentTemplate, facts),
          content: renderTemplate(s.contentTemplate, facts),
          lastRenderedAt: now,
          recalcStatus: "idle" as RecalcStatus,
        };
      }
      return s;
    }),
    artifacts: fieldbook.artifacts.map(a => {
      if (a.contentTemplate && !a.contentRendered) {
        return {
          ...a,
          contentRendered: renderTemplate(a.contentTemplate, facts),
          content: renderTemplate(a.contentTemplate, facts),
          lastRenderedAt: now,
          recalcStatus: "idle" as RecalcStatus,
        };
      }
      return a;
    }),
  };
}

/**
 * Update a fact value and propagate to all items that use it
 */
export function updateFact(
  fieldbook: Fieldbook,
  factKey: string,
  factValue: string
): Fieldbook {
  const newFacts = {
    ...fieldbook.facts,
    [factKey]: factValue,
  };
  
  const now = new Date().toISOString();
  
  // Re-render all items that might use this fact
  const updated: Fieldbook = {
    ...fieldbook,
    facts: newFacts,
    sources: fieldbook.sources.map(s => {
      const template = s.contentTemplate || s.content;
      if (hasTokens(template) && template.includes(`{{${factKey}}}`)) {
        const prevRendered = s.contentRendered || s.content;
        const newRendered = renderTemplate(template, newFacts);
        if (newRendered !== prevRendered) {
          return {
            ...s,
            contentRendered: newRendered,
            content: newRendered,
            lastRenderedAt: now,
            recalcStatus: "recalibrating" as RecalcStatus,
            lastDiff: computeDiff(prevRendered, newRendered),
          };
        }
      }
      return s;
    }),
    syntheses: fieldbook.syntheses.map(s => {
      const template = s.contentTemplate || s.content;
      if (hasTokens(template) && template.includes(`{{${factKey}}}`)) {
        const prevRendered = s.contentRendered || s.content;
        const newRendered = renderTemplate(template, newFacts);
        if (newRendered !== prevRendered) {
          return {
            ...s,
            contentRendered: newRendered,
            content: newRendered,
            lastRenderedAt: now,
            recalcStatus: "recalibrating" as RecalcStatus,
            lastDiff: computeDiff(prevRendered, newRendered),
          };
        }
      }
      return s;
    }),
    artifacts: fieldbook.artifacts.map(a => {
      const template = a.contentTemplate || a.content;
      if (hasTokens(template) && template.includes(`{{${factKey}}}`)) {
        const prevRendered = a.contentRendered || a.content;
        const newRendered = renderTemplate(template, newFacts);
        if (newRendered !== prevRendered) {
          return {
            ...a,
            contentRendered: newRendered,
            content: newRendered,
            lastRenderedAt: now,
            recalcStatus: "recalibrating" as RecalcStatus,
            lastDiff: computeDiff(prevRendered, newRendered),
          };
        }
      }
      return a;
    }),
  };
  
  return updated;
}
