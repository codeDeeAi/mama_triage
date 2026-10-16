/**
 * OpenAPI 3 description of every HTTP route, served by Swagger UI at /api-docs.
 *
 * Hand-written rather than generated from the zod schemas: the routes are few, and the
 * descriptions carry the operational caveats (ACK-before-work, fail-closed admin gating)
 * that a generator would drop. When a route, its zod schema or a parser in
 * whatsapp/parseInbound.ts or telegram/parseUpdate.ts changes, change it here too.
 * test/integration/apiDocs.spec.ts fails if a route, request body or response body is
 * left undocumented, but it cannot tell whether a documented field is still accurate.
 *
 * Routes that a deployment does not mount (admin without config, demo disabled, WhatsApp
 * without credentials) are still listed; calling them there returns the JSON 404.
 */

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: unknown, example?: unknown) => ({
  'application/json': { schema, ...(example !== undefined ? { example } : {}) },
});
const html = { 'text/html': { schema: ref('HtmlPage') } };
const text = (example: string) => ({
  'text/plain': { schema: { type: 'string' }, example },
});
const jsonError = (description: string, example: string) => ({
  description,
  content: json(ref('Error'), { error: example }),
});
const validationError = (description = 'Request body failed validation') => ({
  description,
  content: json(ref('ValidationError')),
});
const notMounted = jsonError('Route not mounted on this deployment', 'not found');

const enumOf = (values: string[], description?: string) => ({
  type: 'string',
  enum: values,
  ...(description ? { description } : {}),
});

// ---- shared domain schemas (mirror src/types.ts and the safety modules) -------------

const schemas = {
  Error: {
    type: 'object',
    required: ['error'],
    properties: { error: { type: 'string', description: 'Human-readable reason.' } },
  },
  ZodIssue: {
    type: 'object',
    description: 'One zod validation issue. Extra keys appear depending on `code`.',
    required: ['code', 'path', 'message'],
    properties: {
      code: { type: 'string', example: 'invalid_type' },
      path: {
        type: 'array',
        items: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
        example: ['turns'],
      },
      message: { type: 'string', example: 'Required' },
      expected: { type: 'string' },
      received: { type: 'string' },
      minimum: { type: 'number' },
      maximum: { type: 'number' },
      options: { type: 'array', items: { type: 'string' } },
    },
  },
  ValidationError: {
    type: 'object',
    required: ['error', 'issues'],
    properties: {
      error: { type: 'string', example: 'invalid request' },
      issues: { type: 'array', items: ref('ZodIssue') },
    },
  },
  HtmlPage: { type: 'string', description: 'Server-rendered HTML (EJS).' },

  Urgency: enumOf(['self_care', 'facility_visit', 'emergency']),
  Pathway: enumOf(['maternal', 'neonatal']),
  PathwayOrUnset: enumOf(['unset', 'maternal', 'neonatal']),
  Language: enumOf(['en', 'pcm'], '`pcm` is Nigerian Pidgin.'),
  Channel: enumOf(['whatsapp', 'telegram']),
  SessionState: enumOf([
    'new', 'awaiting_consent', 'choosing_pathway', 'assessing', 'confirming',
    'completed', 'abandoned', 'escalated',
  ]),
  EscalationSource: {
    ...enumOf(['rules', 'safety_check', 'low_confidence'], 'Which layer raised the urgency; null when none did.'),
    nullable: true,
  },
  FallbackReason: enumOf([
    'llm_unavailable', 'llm_timeout', 'llm_invalid_output', 'circuit_open', 'retrieval_failed',
  ]),
  DistressCategory: enumOf(['self_harm', 'perceived_death_risk', 'acute_panic', 'infant_harm']),
  Slots: {
    type: 'object',
    description: 'Clinical slots collected so far. Every key is optional.',
    additionalProperties: false,
    properties: {
      feeding: enumOf(['normal', 'reduced', 'unable_to_feed']),
      temperature: enumOf(['normal', 'hot_to_touch', 'cold_to_touch']),
      jaundice: enumOf(['none', 'face_only', 'to_palms_soles']),
      breathing: enumOf(['normal', 'fast', 'chest_indrawing', 'grunting_or_apnoea']),
      activity: enumOf(['alert', 'less_active', 'lethargic_or_unresponsive']),
      age_days: { type: 'integer', minimum: 0 },
      cord_appearance: enumOf(['normal', 'red_or_discharging']),
      neonatal_convulsions: enumOf(['no', 'yes']),
      bleeding: enumOf(['normal_lochia', 'heavy', 'soaking_pad_hourly', 'clots_with_dizziness']),
      fever: enumOf(['none', 'mild', 'high_with_chills']),
      wound: enumOf(['healing', 'painful_or_swollen', 'discharge_or_foul_odour']),
      breast: enumOf(['normal', 'engorged_or_cracked', 'red_hot_painful_lump']),
      preeclampsia: enumOf([
        'none', 'headache_or_visual', 'severe_epigastric_or_swelling', 'convulsion',
      ]),
      days_postpartum: { type: 'integer', minimum: 0 },
      delivery_mode: enumOf(['vaginal', 'caesarean']),
      mood_concerns: enumOf(['none', 'low_mood', 'severe']),
    },
    example: { feeding: 'reduced', temperature: 'hot_to_touch', age_days: 5 },
  },
  ReplyButton: {
    type: 'object',
    required: ['id', 'title'],
    properties: {
      id: { type: 'string', example: 'PATHWAY_BABY' },
      title: { type: 'string', example: 'My baby' },
    },
  },
  RedFlagHit: {
    type: 'object',
    required: ['id', 'urgency', 'via', 'evidence', 'source'],
    properties: {
      id: { type: 'string', description: 'Red-flag register rule ID.', example: 'NEO_NOT_FEEDING' },
      urgency: ref('Urgency'),
      via: enumOf(['lexical', 'slot'], 'Matched in the message text, or from a collected slot.'),
      evidence: {
        type: 'string',
        description: 'The matched text, or `slot=value`.',
        example: 'not feeding',
      },
      source: {
        type: 'string',
        description: 'Guideline the rule comes from. `VERIFY:` prefix means not yet clinically verified.',
      },
    },
  },

  // ---- health ----------------------------------------------------------------------
  Liveness: {
    type: 'object',
    required: ['status', 'version'],
    properties: {
      status: { type: 'string', enum: ['ok'] },
      version: { type: 'string', example: '0.1.0', description: '`dev` when unset.' },
    },
  },
  Readiness: {
    type: 'object',
    required: ['status', 'checks'],
    properties: {
      status: enumOf(['ready', 'degraded']),
      checks: {
        type: 'object',
        required: ['database', 'assessment'],
        properties: {
          database: enumOf(['ok', 'unreachable']),
          assessment: {
            type: 'string',
            description:
              'Free-text assessment availability, including the last LLM/retrieval failure. ' +
              '`unknown` when not reported.',
            example: 'ok',
          },
        },
      },
    },
  },

  // ---- registration ----------------------------------------------------------------
  RegisterRequest: {
    type: 'object',
    required: ['displayName', 'channel', 'consent'],
    properties: {
      displayName: { type: 'string', minLength: 1, maxLength: 80, description: 'Trimmed.' },
      channel: ref('Channel'),
      language: { ...schemas_Language(), default: 'en' },
      phone: {
        type: 'string',
        description:
          'WhatsApp: required, at least 10 characters, hashed before storage. ' +
          'Telegram: must be absent.',
      },
      consent: enumOf(['yes'], 'Agreement to the terms and privacy notice. Any other value is rejected.'),
      smsReminders: enumOf(['yes'], 'Opt in to SMS reminders.'),
      smsNumber: {
        type: 'string',
        description: 'Required (≥10 characters) when smsReminders is `yes`; must be absent otherwise.',
      },
    },
  },
  RegisterIssue: {
    type: 'object',
    required: ['field', 'message'],
    properties: {
      field: { type: 'string', example: 'phone' },
      message: { type: 'string', example: 'A phone number is needed for WhatsApp' },
    },
  },
  RegisterIssues: {
    type: 'object',
    required: ['error', 'issues'],
    properties: {
      error: { type: 'string', enum: ['invalid registration'] },
      issues: { type: 'array', items: ref('RegisterIssue') },
    },
  },
  TelegramRegistration: {
    type: 'object',
    required: ['channel', 'displayName', 'registrationId', 'smsReminders', 'deepLink', 'instructions'],
    properties: {
      channel: { type: 'string', enum: ['telegram'] },
      displayName: { type: 'string' },
      registrationId: { type: 'string' },
      smsReminders: { type: 'boolean' },
      deepLink: {
        type: 'string',
        format: 'uri',
        description: 'Opening it binds the Telegram chat to this registration.',
        example: 'https://t.me/MamaTriageBot?start=abc123',
      },
      instructions: { type: 'string' },
    },
  },
  WhatsAppRegistration: {
    type: 'object',
    required: ['channel', 'displayName', 'registrationId', 'smsReminders', 'welcomeSent', 'instructions'],
    properties: {
      channel: { type: 'string', enum: ['whatsapp'] },
      displayName: { type: 'string' },
      registrationId: { type: 'string' },
      smsReminders: { type: 'boolean' },
      welcomeSent: { type: 'boolean', description: 'Whether the welcome template was delivered.' },
      instructions: { type: 'string' },
      whatsappNumber: { type: 'string', description: 'Present when the sending number is known.' },
      whatsappLink: {
        type: 'string',
        format: 'uri',
        description: 'wa.me link pre-filled with "Hi". Present when the sending number is known.',
      },
    },
  },
  RegisterResult: {
    oneOf: [ref('TelegramRegistration'), ref('WhatsAppRegistration')],
    discriminator: { propertyName: 'channel' },
  },
  ChannelsResponse: {
    type: 'object',
    required: ['channels', 'telegramBotUsername', 'studyName'],
    properties: {
      channels: { type: 'array', items: ref('Channel'), description: 'Channels this deployment can use.' },
      telegramBotUsername: { type: 'string', nullable: true },
      studyName: { type: 'string', example: 'the MIVA maternal health study' },
    },
  },

  // ---- WhatsApp webhook (fields read by whatsapp/parseInbound.ts) ------------------
  WhatsAppWebhookPayload: {
    type: 'object',
    description:
      'Meta WhatsApp Cloud API webhook. Only the fields below are read; anything else is ' +
      'ignored. Status callbacks (no `messages`) are acknowledged and dropped.',
    properties: {
      object: { type: 'string', example: 'whatsapp_business_account' },
      entry: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            changes: {
              type: 'array',
              items: {
                type: 'object',
                required: ['value'],
                properties: {
                  value: {
                    type: 'object',
                    properties: {
                      metadata: {
                        type: 'object',
                        required: ['phone_number_id'],
                        properties: { phone_number_id: { type: 'string' } },
                      },
                      messages: { type: 'array', items: ref('WhatsAppMessage') },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  WhatsAppMessage: {
    oneOf: [ref('WhatsAppTextMessage'), ref('WhatsAppInteractiveMessage'), ref('WhatsAppOtherMessage')],
  },
  WhatsAppTextMessage: {
    type: 'object',
    required: ['id', 'from', 'timestamp', 'type', 'text'],
    properties: {
      id: { type: 'string', description: 'wamid; the idempotency key.' },
      from: { type: 'string', description: 'Sender phone number, digits only.' },
      timestamp: { type: 'string', description: 'Unix seconds, as a string.' },
      type: { type: 'string', enum: ['text'] },
      text: {
        type: 'object',
        required: ['body'],
        properties: { body: { type: 'string' } },
      },
    },
  },
  WhatsAppInteractiveMessage: {
    type: 'object',
    required: ['id', 'from', 'timestamp', 'type', 'interactive'],
    properties: {
      id: { type: 'string' },
      from: { type: 'string' },
      timestamp: { type: 'string' },
      type: { type: 'string', enum: ['interactive'] },
      interactive: {
        type: 'object',
        required: ['type'],
        description: 'Exactly one of button_reply / list_reply, matching `type`.',
        properties: {
          type: enumOf(['button_reply', 'list_reply']),
          button_reply: ref('ReplyButton'),
          list_reply: ref('ReplyButton'),
        },
      },
    },
  },
  WhatsAppOtherMessage: {
    type: 'object',
    description: 'Image, audio, location, etc. The sender is told only text is supported.',
    required: ['id', 'from', 'timestamp', 'type'],
    properties: {
      id: { type: 'string' },
      from: { type: 'string' },
      timestamp: { type: 'string' },
      type: { type: 'string', example: 'image' },
    },
  },

  // ---- Telegram webhook (fields read by telegram/parseUpdate.ts) -------------------
  TelegramUser: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'integer' },
      first_name: { type: 'string' },
      language_code: { type: 'string', example: 'en' },
    },
  },
  TelegramChat: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'integer' } },
  },
  TelegramMessage: {
    type: 'object',
    required: ['message_id', 'chat'],
    properties: {
      message_id: { type: 'integer' },
      from: ref('TelegramUser'),
      chat: ref('TelegramChat'),
      date: { type: 'integer', description: 'Unix seconds.' },
      text: {
        type: 'string',
        description:
          'Absent for photos, voice, etc. (sender is told only text is supported). ' +
          '`/start <token>` links a registration.',
      },
    },
  },
  TelegramCallbackQuery: {
    type: 'object',
    required: ['id', 'from'],
    properties: {
      id: { type: 'string', description: 'Acknowledged via answerCallbackQuery.' },
      from: ref('TelegramUser'),
      data: { type: 'string', description: 'Button callback data; used as the reply ID.' },
      message: {
        type: 'object',
        required: ['message_id', 'chat'],
        properties: {
          message_id: { type: 'integer' },
          chat: ref('TelegramChat'),
          date: { type: 'integer' },
        },
      },
    },
  },
  TelegramUpdate: {
    type: 'object',
    description:
      'Telegram Bot API Update. Only `message` and `callback_query` are acted on; ' +
      '`edited_message` and other update types are acknowledged and dropped.',
    required: ['update_id'],
    properties: {
      update_id: { type: 'integer', description: 'Idempotency key.' },
      message: ref('TelegramMessage'),
      edited_message: ref('TelegramMessage'),
      callback_query: ref('TelegramCallbackQuery'),
    },
  },

  // ---- demo ------------------------------------------------------------------------
  DemoSession: {
    type: 'object',
    required: ['sessionId'],
    properties: { sessionId: { type: 'string', format: 'uuid' } },
  },
  DemoMessageRequest: {
    type: 'object',
    required: ['sessionId', 'text'],
    properties: {
      sessionId: { type: 'string', format: 'uuid', description: 'From POST /demo/api/session.' },
      text: { type: 'string', minLength: 1, maxLength: 2000 },
      replyId: {
        type: 'string',
        maxLength: 60,
        description: 'ID of the option clicked, from a previous response’s `options`.',
      },
    },
  },
  DemoLastOutcome: {
    type: 'object',
    required: ['urgency', 'urgencyLlm', 'urgencyRules', 'escalatedBy'],
    properties: {
      urgency: ref('Urgency'),
      urgencyLlm: { ...schemas_Urgency(), nullable: true },
      urgencyRules: { ...schemas_Urgency(), nullable: true },
      escalatedBy: ref('EscalationSource'),
    },
  },
  DemoInspector: {
    type: 'object',
    required: ['state', 'pathway', 'language', 'urgency', 'slots', 'redFlagsThisTurn', 'distress', 'lastOutcome'],
    properties: {
      state: {
        type: 'string',
        description: 'A SessionState, or `completed_or_escalated` when no session is found.',
        example: 'assessing',
      },
      pathway: { ...enumOf(['unset', 'maternal', 'neonatal']), nullable: true },
      language: { ...schemas_Language(), nullable: true },
      urgency: { ...schemas_Urgency(), nullable: true },
      slots: ref('Slots'),
      redFlagsThisTurn: { type: 'array', items: ref('RedFlagHit') },
      distress: { type: 'array', items: ref('DistressCategory') },
      lastOutcome: { allOf: [ref('DemoLastOutcome')], nullable: true },
    },
  },
  DemoMessageResponse: {
    type: 'object',
    required: ['replies', 'options', 'latencyMs', 'inspector'],
    properties: {
      replies: { type: 'array', items: { type: 'string' }, description: 'Bot messages, in order.' },
      options: {
        type: 'array',
        items: ref('ReplyButton'),
        description: 'Buttons offered by the last reply, if any.',
      },
      latencyMs: { type: 'integer' },
      inspector: ref('DemoInspector'),
    },
  },
  DemoFailure: {
    type: 'object',
    required: ['error', 'detail'],
    properties: {
      error: { type: 'string', enum: ['assessment failed'] },
      detail: { type: 'string', description: 'Stringified error.' },
    },
  },

  // ---- admin -----------------------------------------------------------------------
  RegisterStatus: {
    type: 'object',
    required: ['total', 'verified', 'pending', 'simulated', 'reportable', 'fullyAssured'],
    properties: {
      total: { type: 'integer', description: 'Rules in the red-flag register.' },
      verified: { type: 'integer' },
      pending: { type: 'array', items: { type: 'string' }, description: 'Unverified rule IDs.' },
      simulated: {
        type: 'array',
        items: { type: 'string' },
        description: 'Rule IDs verified by a placeholder, not a clinician.',
      },
      reportable: { type: 'boolean', description: 'Every rule has a decision.' },
      fullyAssured: { type: 'boolean', description: 'Every decision is backed by a real source.' },
    },
  },
  KbQueryRequest: {
    type: 'object',
    required: ['query'],
    properties: {
      query: { type: 'string', minLength: 1, example: 'baby not feeding and hot' },
      pathway: { ...enumOf(['unset', 'maternal', 'neonatal']), default: 'unset' },
    },
  },
  KbResult: {
    type: 'object',
    required: ['chunkId', 'score', 'publisher', 'section', 'pathway', 'excerpt'],
    properties: {
      chunkId: { type: 'string', example: 'who-imci#12' },
      score: { type: 'number', description: 'Similarity score.' },
      publisher: { type: 'string', example: 'WHO' },
      section: { type: 'string' },
      pathway: { type: 'string' },
      excerpt: { type: 'string', description: 'First 300 characters of the chunk.' },
    },
  },
  KbQueryResponse: {
    type: 'object',
    required: ['query', 'grounded', 'topScore', 'results', 'indexSize'],
    properties: {
      query: { type: 'string', description: 'The query actually embedded (may be rewritten).' },
      grounded: { type: 'boolean', description: 'Top score cleared the grounding threshold.' },
      topScore: { type: 'number' },
      results: { type: 'array', items: ref('KbResult') },
      indexSize: { type: 'integer', nullable: true, description: 'Chunks in the index.' },
    },
  },
  SimulateRequest: {
    type: 'object',
    required: ['pathway', 'turns'],
    properties: {
      pathway: ref('Pathway'),
      language: { ...schemas_Language(), default: 'en' },
      turns: {
        type: 'array',
        minItems: 1,
        maxItems: 20,
        items: { type: 'string', minLength: 1 },
        description: "The mother's messages, in order.",
      },
    },
    example: {
      pathway: 'neonatal',
      language: 'en',
      turns: ['my baby is 5 days old', 'she is not feeding well and feels hot'],
    },
  },
  SimulateResponse: {
    type: 'object',
    required: ['urgency', 'urgencyLlm', 'escalatedBy', 'redFlags', 'slots', 'replies', 'turnsProcessed', 'latencyMs'],
    properties: {
      urgency: ref('Urgency'),
      urgencyLlm: {
        ...schemas_Urgency(),
        nullable: true,
        description: 'What the model proposed; null if it never ran (e.g. rules escalated first).',
      },
      escalatedBy: ref('EscalationSource'),
      redFlags: { type: 'array', items: { type: 'string' }, description: 'Red-flag rule IDs that fired.' },
      slots: ref('Slots'),
      replies: { type: 'array', items: { type: 'string' } },
      turnsProcessed: {
        type: 'integer',
        description: 'Turns consumed before an emergency or conclusion stopped the run.',
      },
      latencyMs: { type: 'integer' },
      fallbackReason: {
        allOf: [ref('FallbackReason')],
        description: 'Present only when a turn fell back to the static danger-sign message.',
      },
    },
  },
};

// Inline copies for places that add `nullable`/`default` (sibling keys next to $ref are
// ignored in OpenAPI 3.0).
function schemas_Urgency() {
  return enumOf(['self_care', 'facility_visit', 'emergency']);
}
function schemas_Language() {
  return enumOf(['en', 'pcm'], '`pcm` is Nigerian Pidgin.');
}

const adminAuthResponses = {
  401: jsonError('Missing or wrong bearer token', 'unauthorized'),
  404: jsonError('Admin disabled (production without ADMIN_TOKEN, or not mounted)', 'not found'),
};

export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'MamaTriage API',
    version: process.env.npm_package_version ?? '0.1.0',
    description:
      'Triage and symptom assessment for postpartum mothers and newborns, delivered over ' +
      'WhatsApp and Telegram.\n\n' +
      'Unknown paths return `404 {"error":"not found"}` (JSON for `/api` paths and JSON ' +
      'clients, an HTML page otherwise). An unhandled error returns ' +
      '`500 {"error":"internal error"}`.',
  },
  servers: [{ url: '/' }],
  tags: [
    { name: 'Health', description: 'Liveness and readiness probes' },
    { name: 'Registration', description: 'Enrolling a mother on a messaging channel' },
    { name: 'Webhooks', description: 'Inbound deliveries from WhatsApp (Meta) and Telegram' },
    { name: 'Demo', description: 'Browser demonstration driving the real message handler' },
    { name: 'Admin', description: 'Debug and evaluation routes. Bearer token required in production.' },
    { name: 'Pages', description: 'Server-rendered HTML pages' },
  ],
  components: {
    securitySchemes: {
      adminBearer: {
        type: 'http',
        scheme: 'bearer',
        description: 'ADMIN_TOKEN. In production with no token configured, /admin routes return 404.',
      },
      telegramSecret: {
        type: 'apiKey',
        in: 'header',
        name: 'X-Telegram-Bot-Api-Secret-Token',
        description: 'The secret_token registered with Telegram setWebhook.',
      },
      metaSignature: {
        type: 'apiKey',
        in: 'header',
        name: 'X-Hub-Signature-256',
        description: '`sha256=` + hex HMAC-SHA256 of the raw body, keyed with the Meta app secret.',
      },
    },
    schemas,
  },
  paths: {
    // --- health ---------------------------------------------------------------------
    '/healthz': {
      get: {
        tags: ['Health'],
        summary: 'Liveness',
        description: 'The process is up. Does not touch the database.',
        responses: {
          200: { description: 'Alive', content: json(ref('Liveness'), { status: 'ok', version: '0.1.0' }) },
        },
      },
    },
    '/readyz': {
      get: {
        tags: ['Health'],
        summary: 'Readiness',
        description:
          'Database reachability plus assessment status. Assessment being down does not ' +
          'change the status code: the deterministic safety layer still works.',
        responses: {
          200: {
            description: 'Database reachable',
            content: json(ref('Readiness'), { status: 'ready', checks: { database: 'ok', assessment: 'ok' } }),
          },
          503: {
            description: 'Database unreachable',
            content: json(ref('Readiness'), {
              status: 'degraded',
              checks: { database: 'unreachable', assessment: 'ok' },
            }),
          },
        },
      },
    },

    // --- registration ---------------------------------------------------------------
    '/register/api/channels': {
      get: {
        tags: ['Registration'],
        summary: 'Channels this deployment offers',
        responses: {
          200: {
            description: 'Available channels',
            content: json(ref('ChannelsResponse'), {
              channels: ['telegram'],
              telegramBotUsername: 'MamaTriageBot',
              studyName: 'the MIVA maternal health study',
            }),
          },
          404: notMounted,
        },
      },
    },
    '/register/api': {
      post: {
        tags: ['Registration'],
        summary: 'Register (JSON)',
        description:
          'Telegram collects no phone number and returns a deep link. WhatsApp hashes the ' +
          'number before storage and sends the welcome template.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: ref('RegisterRequest'),
              examples: {
                telegram: {
                  summary: 'Telegram',
                  value: { displayName: 'Amaka', channel: 'telegram', language: 'en', consent: 'yes' },
                },
                whatsapp: {
                  summary: 'WhatsApp with SMS reminders',
                  value: {
                    displayName: 'Amaka', channel: 'whatsapp', language: 'pcm',
                    phone: '08031234567', consent: 'yes',
                    smsReminders: 'yes', smsNumber: '08031234567',
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Registered',
            content: {
              'application/json': {
                schema: ref('RegisterResult'),
                examples: {
                  telegram: {
                    value: {
                      channel: 'telegram', displayName: 'Amaka', registrationId: '42',
                      smsReminders: false,
                      deepLink: 'https://t.me/MamaTriageBot?start=abc123',
                      instructions: 'Open the link on the phone that has Telegram installed, then press START.',
                    },
                  },
                  whatsapp: {
                    value: {
                      channel: 'whatsapp', displayName: 'Amaka', registrationId: '43',
                      smsReminders: true, welcomeSent: true,
                      instructions: 'Check WhatsApp for a message from us, and reply to begin.',
                      whatsappNumber: '+234 803 000 0000',
                      whatsappLink: 'https://wa.me/2348030000000?text=Hi',
                    },
                  },
                },
              },
            },
          },
          400: {
            description: 'Validation failed, channel unavailable, or phone number unparseable',
            content: json(ref('RegisterIssues'), {
              error: 'invalid registration',
              issues: [{ field: 'phone', message: 'A phone number is needed for WhatsApp' }],
            }),
          },
          404: notMounted,
        },
      },
    },
    '/register': {
      get: {
        tags: ['Pages'],
        summary: 'Registration form',
        responses: { 200: { description: 'HTML page', content: html }, 404: notMounted },
      },
      post: {
        tags: ['Registration'],
        summary: 'Register (HTML form / htmx)',
        description:
          'Same body and validation as /register/api, form-encoded. With `HX-Request: true` ' +
          'the response is an HTML fragment for htmx to swap in; otherwise a full page.',
        parameters: [
          {
            name: 'HX-Request',
            in: 'header',
            required: false,
            schema: { type: 'string', enum: ['true'] },
            description: 'Sent by htmx; selects a fragment response.',
          },
        ],
        requestBody: {
          required: true,
          content: { 'application/x-www-form-urlencoded': { schema: ref('RegisterRequest') } },
        },
        responses: {
          200: { description: 'Success page, or result fragment for htmx', content: html },
          422: { description: 'Form re-rendered with field errors', content: html },
          404: notMounted,
        },
      },
    },
    '/': {
      get: {
        tags: ['Pages'],
        summary: 'Landing page',
        responses: { 200: { description: 'HTML page', content: html } },
      },
    },
    '/privacy': {
      get: {
        tags: ['Pages'],
        summary: 'Privacy notice',
        responses: { 200: { description: 'HTML page', content: html } },
      },
    },
    '/terms': {
      get: {
        tags: ['Pages'],
        summary: 'Terms of use',
        responses: { 200: { description: 'HTML page', content: html } },
      },
    },

    // --- webhooks -------------------------------------------------------------------
    '/webhook': {
      get: {
        tags: ['Webhooks'],
        summary: 'WhatsApp subscription handshake',
        description: "Meta's one-time verification. Echoes hub.challenge when the token matches.",
        parameters: [
          { name: 'hub.mode', in: 'query', required: true, schema: { type: 'string', enum: ['subscribe'] } },
          {
            name: 'hub.verify_token',
            in: 'query',
            required: true,
            schema: { type: 'string' },
            description: 'Must equal WHATSAPP_VERIFY_TOKEN.',
          },
          { name: 'hub.challenge', in: 'query', required: true, schema: { type: 'string' } },
        ],
        responses: {
          200: { description: 'The challenge, echoed verbatim', content: text('1158201444') },
          403: { description: 'Wrong mode or token', content: text('Forbidden') },
        },
      },
      post: {
        tags: ['Webhooks'],
        summary: 'WhatsApp inbound delivery',
        description:
          'Signature is verified over the raw body. Acknowledged with 200 before any ' +
          'processing; messages are claimed by ID so Meta retries are dropped. A payload ' +
          'that does not match the schema is acknowledged and ignored.',
        security: [{ metaSignature: [] }],
        requestBody: {
          required: true,
          content: json(ref('WhatsAppWebhookPayload'), {
            object: 'whatsapp_business_account',
            entry: [{
              changes: [{
                value: {
                  metadata: { phone_number_id: '123456789' },
                  messages: [{
                    id: 'wamid.HBgM...',
                    from: '2348031234567',
                    timestamp: '1760600000',
                    type: 'text',
                    text: { body: 'my baby is not feeding' },
                  }],
                },
              }],
            }],
          }),
        },
        responses: {
          200: { description: 'Acknowledged', content: text('OK') },
          400: jsonError('Body is not valid JSON', 'malformed JSON body'),
          401: {
            description: 'Signature missing or wrong',
            content: {
              'application/json': {
                schema: ref('Error'),
                examples: {
                  missing: { value: { error: 'missing signature' } },
                  invalid: { value: { error: 'invalid signature' } },
                },
              },
            },
          },
          404: notMounted,
          500: jsonError(
            'Server misconfigured: body was parsed before signature verification',
            'raw body unavailable for signature verification',
          ),
        },
      },
    },
    '/telegram/webhook': {
      post: {
        tags: ['Webhooks'],
        summary: 'Telegram update',
        description:
          'Authenticated by shared secret header (constant-time compare). Acknowledged with ' +
          '200 before processing; updates are claimed by update_id for idempotency. Updates ' +
          'that do not match the schema are acknowledged and ignored.',
        security: [{ telegramSecret: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: ref('TelegramUpdate'),
              examples: {
                text: {
                  summary: 'Text message',
                  value: {
                    update_id: 1001,
                    message: {
                      message_id: 7,
                      from: { id: 555, first_name: 'Amaka', language_code: 'en' },
                      chat: { id: 555 },
                      date: 1760600000,
                      text: 'my baby is not feeding',
                    },
                  },
                },
                start: {
                  summary: 'Deep-link start',
                  value: {
                    update_id: 1000,
                    message: { message_id: 1, chat: { id: 555 }, date: 1760600000, text: '/start abc123' },
                  },
                },
                button: {
                  summary: 'Button tap',
                  value: {
                    update_id: 1002,
                    callback_query: {
                      id: '4382bfdwdsb323b2d9',
                      from: { id: 555 },
                      data: 'PATHWAY_BABY',
                      message: { message_id: 8, chat: { id: 555 }, date: 1760600010 },
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Acknowledged', content: text('OK') },
          401: { description: 'Bad or missing secret token', content: text('Unauthorized') },
          404: notMounted,
        },
      },
    },

    // --- demo -----------------------------------------------------------------------
    '/demo/api/session': {
      post: {
        tags: ['Demo'],
        summary: 'Start a demo conversation',
        description: 'Takes no body.',
        responses: {
          200: {
            description: 'New session',
            content: json(ref('DemoSession'), { sessionId: '3f1c2a9e-0b5d-4f7a-9c1e-2d4b6a8c0e1f' }),
          },
          404: jsonError('Demo disabled', 'not found'),
        },
      },
    },
    '/demo/api/message': {
      post: {
        tags: ['Demo'],
        summary: 'Send a message in a demo conversation',
        description:
          'Runs the real handler (consent, safety scan, assessment, persistence) with a ' +
          'capturing transport, and returns the replies plus inspector data.',
        requestBody: {
          required: true,
          content: json(ref('DemoMessageRequest'), {
            sessionId: '3f1c2a9e-0b5d-4f7a-9c1e-2d4b6a8c0e1f',
            text: 'My baby',
            replyId: 'PATHWAY_BABY',
          }),
        },
        responses: {
          200: {
            description: 'Replies and inspector data',
            content: json(ref('DemoMessageResponse'), {
              replies: ['How old is your baby, in days?'],
              options: [],
              latencyMs: 1840,
              inspector: {
                state: 'assessing',
                pathway: 'neonatal',
                language: 'en',
                urgency: null,
                slots: {},
                redFlagsThisTurn: [],
                distress: [],
                lastOutcome: null,
              },
            }),
          },
          400: validationError(),
          404: jsonError('Demo disabled', 'not found'),
          500: { description: 'The handler threw', content: json(ref('DemoFailure')) },
        },
      },
    },

    // --- admin ----------------------------------------------------------------------
    '/admin/register': {
      get: {
        tags: ['Admin'],
        summary: 'Red-flag register verification status',
        security: [{ adminBearer: [] }],
        responses: {
          200: {
            description: 'Register status',
            content: json(ref('RegisterStatus'), {
              total: 18, verified: 18, pending: [], simulated: ['NEO_NOT_FEEDING'],
              reportable: true, fullyAssured: false,
            }),
          },
          ...adminAuthResponses,
        },
      },
    },
    '/admin/kb/query': {
      post: {
        tags: ['Admin'],
        summary: 'Query the knowledge base',
        security: [{ adminBearer: [] }],
        requestBody: { required: true, content: json(ref('KbQueryRequest')) },
        responses: {
          200: { description: 'Retrieval results', content: json(ref('KbQueryResponse')) },
          400: validationError(),
          ...adminAuthResponses,
          503: jsonError('Knowledge index not loaded', 'knowledge index unavailable'),
        },
      },
    },
    '/admin/simulate': {
      post: {
        tags: ['Admin'],
        summary: 'Run a full assessment without a messaging channel',
        description:
          'Applies the deterministic safety scan before every turn, exactly as the live ' +
          'handler does. Stops at the first emergency or concluded assessment.',
        security: [{ adminBearer: [] }],
        requestBody: { required: true, content: json(ref('SimulateRequest')) },
        responses: {
          200: {
            description: 'Assessment outcome',
            content: json(ref('SimulateResponse'), {
              urgency: 'emergency',
              urgencyLlm: null,
              escalatedBy: 'rules',
              redFlags: ['NEO_NOT_FEEDING'],
              slots: { age_days: 5 },
              replies: ['This could be serious. Take your baby to the nearest hospital now.'],
              turnsProcessed: 2,
              latencyMs: 1320,
            }),
          },
          400: validationError(),
          ...adminAuthResponses,
          503: jsonError('Knowledge index not loaded', 'assessment unavailable — knowledge index not loaded'),
        },
      },
    },
  },
};
