import {
  BOT_COMMANDS,
  commandListMessage,
  dangerSignsMessage,
  getStartedMessage,
  parseCommand,
  privacyMessage,
  restartedMessage,
  stoppedMessage,
} from '../../../src/orchestrator/commands';
import { dangerSigns } from '../../../src/safety/fallback';
import { toMarkdownV2 } from '../../../src/telegram/client';
import type { Language } from '../../../src/types';

const LANGUAGES: Language[] = ['en', 'pcm'];

describe('parseCommand', () => {
  it('recognises every command in the registry', () => {
    for (const c of BOT_COMMANDS) {
      expect(parseCommand(`/${c.name}`)).toBe(c.name);
    }
  });

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(parseCommand('/HELP')).toBe('help');
    expect(parseCommand('  /Help  ')).toBe('help');
  });

  it('accepts the @BotName suffix Telegram appends in groups', () => {
    expect(parseCommand('/help@MamaTriageBot')).toBe('help');
  });

  it('rejects an unknown command rather than guessing', () => {
    expect(parseCommand('/wharrgarbl')).toBeNull();
    expect(parseCommand('/')).toBeNull();
  });

  it('does not match a command with anything after it', () => {
    // The whole reason the pattern is anchored. "/stop the bleeding" is a description of
    // a symptom, and treating it as a command would discard it before the safety scan.
    expect(parseCommand('/stop the bleeding is not stopping')).toBeNull();
    expect(parseCommand('/danger my baby is floppy')).toBeNull();
  });

  it('does not match ordinary text that merely contains a slash', () => {
    expect(parseCommand('bleeding 2/3 days')).toBeNull();
    expect(parseCommand('help')).toBeNull();
  });
});

describe('command copy', () => {
  it.each(LANGUAGES)('the welcome text lists every command (%s)', (language) => {
    const body = getStartedMessage(language);
    for (const c of BOT_COMMANDS) {
      expect(body).toContain(`/${c.name}`);
    }
  });

  it.each(LANGUAGES)('the welcome text keeps the "not a doctor" limit (%s)', (language) => {
    expect(getStartedMessage(language)).toMatch(
      language === 'en' ? /not a doctor/i : /no be doctor/i,
    );
  });

  it.each(LANGUAGES)('the command list names every command (%s)', (language) => {
    const body = commandListMessage(language);
    for (const c of BOT_COMMANDS) {
      expect(body).toContain(`/${c.name}`);
    }
  });

  it.each(LANGUAGES)('/privacy states that the number is not saved (%s)', (language) => {
    expect(privacyMessage(language)).toMatch(
      language === 'en' ? /never saved/i : /no dey save/i,
    );
  });

  it.each(LANGUAGES)('/stop still points to a facility (%s)', (language) => {
    expect(stoppedMessage(language)).toMatch(
      language === 'en' ? /health facility/i : /health centre/i,
    );
    expect(stoppedMessage(language)).toContain('/start');
  });

  it.each(LANGUAGES)('/restart confirms the previous check is closed (%s)', (language) => {
    expect(restartedMessage(language).length).toBeGreaterThan(0);
  });

  /**
   * Every one of these is sent through TelegramClient.sendMessage, which converts
   * `*bold*` to MarkdownV2. That conversion splits on the asterisk, so an unbalanced one
   * corrupts the escaping and Telegram rejects the whole message — silently dropping,
   * among other things, the danger-sign list.
   */
  it('uses balanced bold markers everywhere', () => {
    const bodies = LANGUAGES.flatMap((l) => [
      getStartedMessage(l),
      commandListMessage(l),
      privacyMessage(l),
      stoppedMessage(l),
      restartedMessage(l),
      dangerSignsMessage('unset', l),
      dangerSignsMessage('maternal', l),
      dangerSignsMessage('neonatal', l),
    ]);

    for (const body of bodies) {
      const asterisks = (body.match(/\*/g) ?? []).length;
      expect(asterisks % 2).toBe(0);
      // The conversion must carry the bold markers through untouched — it escapes
      // everything else, so a lost asterisk means the emphasis became literal text.
      expect((toMarkdownV2(body).match(/(?<!\\)\*/g) ?? []).length).toBe(asterisks);
    }
  });
});

describe('dangerSignsMessage', () => {
  it.each(LANGUAGES)('shows only the maternal list for a maternal session (%s)', (language) => {
    const body = dangerSignsMessage('maternal', language);
    for (const sign of dangerSigns('maternal', language)) expect(body).toContain(sign);
    for (const sign of dangerSigns('neonatal', language)) expect(body).not.toContain(sign);
  });

  it.each(LANGUAGES)('shows only the neonatal list for a neonatal session (%s)', (language) => {
    const body = dangerSignsMessage('neonatal', language);
    for (const sign of dangerSigns('neonatal', language)) expect(body).toContain(sign);
    for (const sign of dangerSigns('maternal', language)) expect(body).not.toContain(sign);
  });

  it.each(LANGUAGES)('shows both lists before a pathway is chosen (%s)', (language) => {
    // We do not know who she is asking about yet, so omitting either would be a guess.
    const body = dangerSignsMessage('unset', language);
    for (const sign of dangerSigns('maternal', language)) expect(body).toContain(sign);
    for (const sign of dangerSigns('neonatal', language)) expect(body).toContain(sign);
  });

  it.each(LANGUAGES)('carries the standing disclaimer (%s)', (language) => {
    expect(dangerSignsMessage('unset', language)).toMatch(
      language === 'en' ? /not a diagnosis/i : /no be doctor talk/i,
    );
  });
});

describe('BOT_COMMANDS registry', () => {
  it('has no duplicates', () => {
    const names = BOT_COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('satisfies Telegram\'s constraints on setMyCommands', () => {
    for (const c of BOT_COMMANDS) {
      // Telegram: 1-32 chars, lowercase letters, digits and underscores only.
      expect(c.name).toMatch(/^[a-z0-9_]{1,32}$/);
      // Telegram: 1-256 chars.
      expect(c.description.length).toBeGreaterThan(0);
      expect(c.description.length).toBeLessThanOrEqual(256);
    }
  });
});
