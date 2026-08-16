/**
 * Bot commands.
 *
 * Telegram has a first-class notion of a command: a bot that registers its commands with
 * `setMyCommands` gets a Menu button and inline autocomplete, so a mother discovers what
 * she can ask for without anyone documenting it. That discoverability is the whole point —
 * before this, the only way to learn the bot could do anything but answer questions was to
 * be told.
 *
 * One registry, three consumers: the Telegram menu registration at boot, the `/commands`
 * listing, and the parser. They cannot drift apart, so a command can never appear in the
 * menu without being handled — which is worse than not offering it at all, because a
 * mother who taps it gets silence.
 *
 * The copy lives here rather than in the handler because it is the same kind of thing as
 * the consent text: fixed wording, both languages, no model involvement. WhatsApp-style
 * `*bold*` is used throughout; the Telegram client converts it (see toMarkdownV2).
 */

import { dangerSigns } from '../safety/fallback';
import type { Language, Pathway } from '../types';

export type CommandName =
  | 'start'
  | 'help'
  | 'commands'
  | 'danger'
  | 'restart'
  | 'privacy'
  | 'stop';

export interface BotCommand {
  name: CommandName;
  /**
   * Shown in Telegram's command menu.
   *
   * English only, and lower case because Telegram renders these verbatim beside the
   * command. Descriptions are registered once at boot, before any mother has written, so
   * there is no language to match them to — the messages the commands produce are
   * translated, which is where it actually matters.
   */
  description: string;
}

/** Every command the bot answers, in the order the menu should show them. */
export const BOT_COMMANDS: readonly BotCommand[] = [
  { name: 'start', description: 'begin or resume a check' },
  { name: 'help', description: 'what I can and cannot do' },
  { name: 'commands', description: 'list everything you can type' },
  { name: 'danger', description: 'danger signs to watch for' },
  { name: 'restart', description: 'start a new check from the beginning' },
  { name: 'privacy', description: 'what is stored, and what is not' },
  { name: 'stop', description: 'end this check' },
];

/**
 * Recognise a command, or return null.
 *
 * Anchored on purpose. Only a message that is *entirely* a command matches, so "/stop the
 * bleeding is not stopping" is symptom text and reaches the safety scan — which is the
 * behaviour that matters, since the alternative silently discards a description of a
 * haemorrhage. The `@BotName` suffix Telegram appends in group chats is accepted because
 * it is Telegram's own addition to a command the mother typed bare.
 */
export function parseCommand(text: string): CommandName | null {
  const match = /^\/([a-z_]+)(?:@[\w]+)?$/i.exec(text.trim());
  if (!match) return null;
  const name = match[1]?.toLowerCase();
  const known = BOT_COMMANDS.find((c) => c.name === name);
  return known ? known.name : null;
}

const COMMAND_LABELS: Record<CommandName, Record<Language, string>> = {
  start: { en: 'begin or resume a check', pcm: 'start or continue a check' },
  help: { en: 'what I can and cannot do', pcm: 'wetin I fit and no fit do' },
  commands: { en: 'this list', pcm: 'dis list' },
  danger: { en: 'the danger signs to watch for', pcm: 'di danger signs to dey watch' },
  restart: {
    en: 'start a new check from the beginning',
    pcm: 'start new check from beginning',
  },
  privacy: { en: 'what is stored, and what is not', pcm: 'wetin we dey keep, and wetin we no dey keep' },
  stop: { en: 'end this check', pcm: 'end dis check' },
};

const EMERGENCY_NOTE: Record<Language, string> = {
  en: 'If this is an emergency, do not wait for me. Go to the nearest health facility now.',
  pcm: 'If na emergency, no wait for me. Go health centre wey dey near you now now.',
};

/** The command list, one per line. Shared by the welcome text and `/commands`. */
function commandLines(language: Language): string {
  return BOT_COMMANDS.map((c) => `/${c.name} — ${COMMAND_LABELS[c.name][language]}`).join('\n');
}

/**
 * The getting-started message.
 *
 * Answers `/help`, and `/start` when a mother already has a session running. Those are the
 * same question asked twice — "what is this and what can I do here" — and answering it
 * with one text means the two can never drift into contradicting each other.
 *
 * Deliberately repeats the "not a doctor" line from the consent message. A mother who
 * reaches for /help is usually unsure, and that is the wrong moment to make her scroll up.
 */
export function getStartedMessage(language: Language): string {
  if (language === 'pcm') {
    return [
      '👋 *MamaTriage*',
      '',
      'Na research prototype I be wey dey help check danger signs for mama and new pikin.',
      '',
      '*I no be doctor and I no dey give diagnosis.* I fit help you decide if to care for ' +
        'house, go clinic, or run go emergency.',
      '',
      '*Wetin you fit type:*',
      commandLines('pcm'),
      '',
      EMERGENCY_NOTE.pcm,
    ].join('\n');
  }

  return [
    '👋 *MamaTriage*',
    '',
    'I am a research prototype that helps check danger signs for mothers and newborn babies.',
    '',
    '*I am not a doctor and I do not give diagnoses.* I can help you decide whether to care ' +
      'at home, visit a clinic, or go for emergency help.',
    '',
    '*What you can type:*',
    commandLines('en'),
    '',
    EMERGENCY_NOTE.en,
  ].join('\n');
}

/** `/commands` — the list on its own, for someone who only wants reminding. */
export function commandListMessage(language: Language): string {
  return [
    language === 'en' ? '*What you can type:*' : '*Wetin you fit type:*',
    '',
    commandLines(language),
  ].join('\n');
}

/**
 * `/danger` — the danger-sign list on demand.
 *
 * Reuses the register the failure fallback prints, so there is one wording of the signs
 * regardless of whether a mother asked for them or the system had to volunteer them.
 * Before a pathway is chosen both lists are shown, because we do not yet know who she is
 * asking about and omitting one would be a guess.
 */
export function dangerSignsMessage(pathway: Pathway, language: Language): string {
  const lines: string[] = [
    language === 'en'
      ? '*Danger signs — go to a health facility if you see any of these*'
      : '*Danger signs — go health centre if you see any of dis*',
    '',
  ];

  const both = pathway === 'unset';
  if (both) lines.push(language === 'en' ? '*For the mother:*' : '*For mama:*');
  if (pathway === 'maternal' || both) {
    for (const sign of dangerSigns('maternal', language)) lines.push(`• ${sign}`);
    if (both) lines.push('');
  }
  if (both) lines.push(language === 'en' ? '*For the baby:*' : '*For di pikin:*');
  if (pathway === 'neonatal' || both) {
    for (const sign of dangerSigns('neonatal', language)) lines.push(`• ${sign}`);
  }

  lines.push('');
  lines.push(
    language === 'en'
      ? 'This is guidance, not a diagnosis. If you are worried, go to the nearest health facility.'
      : 'Na guide be dis, no be doctor talk. If you dey worry, go health centre wey dey near you.',
  );
  return lines.join('\n');
}

/**
 * `/privacy` — the standing answer to "what happens to what I type".
 *
 * Every claim here is one the code actually enforces: the identity hash (hashIdentity),
 * the redactor that runs before any message text is written (privacy/redact.ts), and the
 * consent gate. Nothing aspirational belongs in this message.
 */
export function privacyMessage(language: Language): string {
  if (language === 'pcm') {
    return [
      '*Wetin we dey keep*',
      '',
      '• Anonymous copy of dis conversation, for research work.',
      '• Phone number, email and link wey you type inside message dey removed before we keep am.',
      '',
      '*Wetin we no dey keep*',
      '',
      '• We no dey save your phone number or your Telegram name. Na one-way code wey nobody ' +
        'fit turn back to your number we dey use.',
      '',
      'You fit end dis check any time with /stop.',
    ].join('\n');
  }

  return [
    '*What is stored*',
    '',
    '• An anonymous copy of this conversation, for research.',
    '• Phone numbers, emails and links written inside a message are removed before it is stored.',
    '',
    '*What is not stored*',
    '',
    '• Your phone number and your Telegram name are never saved. They are replaced by a ' +
      'one-way code that cannot be turned back into either.',
    '',
    'You can end this check at any time with /stop.',
  ].join('\n');
}

/** `/restart` — confirmation that the previous check is closed and a new one is open. */
export function restartedMessage(language: Language): string {
  return language === 'en'
    ? 'I have closed that check and started a new one.'
    : 'I don close dat check, I don start new one.';
}

/** `/stop` — confirmation, plus the one instruction that still applies afterwards. */
export function stoppedMessage(language: Language): string {
  return language === 'en'
    ? [
        'I have ended this check.',
        '',
        'If you or your baby are unwell, please go to the nearest health facility.',
        '',
        'Send /start any time to begin again.',
      ].join('\n')
    : [
        'I don end dis check.',
        '',
        'If you or your pikin no well, abeg go health centre wey dey near you.',
        '',
        'Send /start any time make we start again.',
      ].join('\n');
}
