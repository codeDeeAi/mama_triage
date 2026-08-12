/**
 * Clinical reviewer sign-off pack.
 *
 * Generates `docs/requirements/red-flag-register.md` from the live register, so the
 * document a clinician signs cannot drift from the code that runs.
 *
 * Regular expressions are not a reviewable artefact. What a reviewer needs is: what
 * phrasings does this catch, what urgency does it assign, and which guideline section is
 * that drawn from — plus somewhere to record their decision. That is what this emits.
 *
 * Run with: npm run docs:register
 */

import { RED_FLAGS, type RedFlagRule } from './redFlags';
import type { Urgency } from '../types';

const URGENCY_LABEL: Record<Urgency, string> = {
  emergency: 'EMERGENCY — refer immediately',
  facility_visit: 'FACILITY VISIT — seen within 24 hours',
  self_care: 'SELF CARE — manage at home with guidance',
};

const PATHWAY_LABEL: Record<string, string> = {
  maternal: 'Postpartum mother',
  neonatal: 'Newborn / young infant',
  unset: 'Both',
};

export function renderReviewDoc(rules: readonly RedFlagRule[] = RED_FLAGS): string {
  const out: string[] = [];
  const pending = rules.filter((r) => !r.verified);

  out.push('# Red-flag register — clinical review and sign-off');
  out.push('');
  out.push(
    '> Generated from the live register by `npm run docs:register`. Do not edit by hand — ' +
      'edits here will be overwritten, and the signed document must match the code that runs.',
  );
  out.push('');

  out.push('## What you are being asked to do');
  out.push('');
  out.push(
    'This system runs a set of deterministic rules **before and independently of** the ' +
      'language model. If a rule below matches what a mother writes, the system assigns ' +
      'the stated urgency and issues that advice — regardless of what the model concludes. ' +
      'These rules are the safety floor.',
  );
  out.push('');
  out.push('For each rule, please confirm or correct three things:');
  out.push('');
  out.push('1. **Urgency** — is the assigned tier clinically right for this presentation?');
  out.push(
    '2. **Source** — which section of WHO IMCI or the FMOH BEmONC protocol does this ' +
      'derive from? Each entry currently carries a `VERIFY:` marker and a best guess.',
  );
  out.push(
    '3. **Phrasings** — do the example phrasings genuinely describe the danger sign, and ' +
      'is anything important missing? Missing phrasings are the main way a system like ' +
      'this misses an emergency.',
  );
  out.push('');
  out.push(
    'Record your decision in the sign-off block under each rule. Where you disagree, ' +
      'please say what the tier should be and why — the disagreement is as useful as the ' +
      'agreement.',
  );
  out.push('');

  out.push('## Status');
  out.push('');
  out.push(`- Rules in register: **${rules.length}**`);
  out.push(`- Signed off: **${rules.length - pending.length}**`);
  out.push(`- Awaiting review: **${pending.length}**`);
  out.push('');
  if (pending.length > 0) {
    out.push(
      '> ⚠️ While any rule is unverified the evaluation runner refuses to produce ' +
        'reportable results (`assertRegisterVerified()`), and generated reports are ' +
        'stamped NOT REPORTABLE. This is deliberate.',
    );
    out.push('');
  }

  out.push('## Summary');
  out.push('');
  out.push('| ID | Danger sign | Applies to | Assigned urgency | Reviewed |');
  out.push('|---|---|---|---|---|');
  for (const r of rules) {
    out.push(
      `| \`${r.id}\` | ${r.label} | ${PATHWAY_LABEL[r.pathway]} | ${r.urgency} | ${r.verified ? '✅' : '⬜'} |`,
    );
  }
  out.push('');

  for (const group of ['maternal', 'neonatal'] as const) {
    const inGroup = rules.filter((r) => r.pathway === group);
    if (inGroup.length === 0) continue;

    out.push('---');
    out.push('');
    out.push(`# ${PATHWAY_LABEL[group]}`);
    out.push('');

    for (const r of inGroup) {
      out.push(`## \`${r.id}\` — ${r.label}`);
      out.push('');
      out.push(`**Assigned urgency:** ${URGENCY_LABEL[r.urgency]}`);
      out.push('');
      out.push(`**Proposed source:** ${r.source}`);
      out.push('');
      out.push('**Phrasings this rule catches:**');
      out.push('');
      for (const example of r.examples) out.push(`- "${example}"`);
      out.push('');

      if (r.slot) {
        const clauses = Object.entries(r.slot)
          .map(([k, v]) => `\`${k}\` = \`${String(v)}\``)
          .join(', ');
        out.push(
          `**Also fires when** the assessment records ${clauses} — that is, when the ` +
            'model has understood the mother to mean this even if she used different words.',
        );
        out.push('');
      }

      out.push('| Reviewer question | Response |');
      out.push('|---|---|');
      out.push(`| Is \`${r.urgency}\` the correct urgency? | ☐ Yes ☐ No — should be: ________ |`);
      out.push('| Correct guideline section | ________________________________ |');
      out.push('| Missing phrasings to add | ________________________________ |');
      out.push('| Phrasings that should NOT fire this | ________________________________ |');
      out.push('| Reviewer name / date | ________________________________ |');
      out.push('');
    }
  }

  out.push('---');
  out.push('');
  out.push('## After review');
  out.push('');
  out.push('For each rule the reviewer has approved, the developer updates `src/safety/redFlags.ts`:');
  out.push('');
  out.push('```ts');
  out.push("source: 'WHO IMCI 2014, Chart 2 — Check for very severe disease',  // no VERIFY marker");
  out.push('verified: true,');
  out.push('```');
  out.push('');
  out.push(
    'Once every rule is verified, `assertRegisterVerified()` stops throwing and the ' +
      'evaluation harness will produce reportable results. This generated document, with ' +
      'the completed sign-off blocks, becomes an appendix in the dissertation.',
  );
  out.push('');

  return out.join('\n');
}

/* istanbul ignore next -- CLI wiring */
if (require.main === module) {
  const { writeFileSync, mkdirSync } = require('node:fs') as typeof import('node:fs');
  const path = process.argv[2] ?? 'docs/requirements/red-flag-register.md';
  mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  writeFileSync(path, renderReviewDoc(), 'utf8');
  process.stdout.write(`Wrote ${path} (${RED_FLAGS.length} rules)\n`);
}
