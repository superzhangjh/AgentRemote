import { sessionsDb } from '@/modules/database/index.js';
import {
  createOpenCodeServerClient,
  findOpenCodeServerConfig,
  readOpenCodeSessionInfo,
} from '@/modules/providers/list/opencode/opencode-server.js';
import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  readObjectRecord,
  readOptionalString,
} from '@/shared/utils.js';

/**
 * Curated OpenCode catalog shipped as immutable CloudCLI defaults.
 *
 * OpenCode routes by `<providerID>/<modelID>`, so this list mirrors the
 * providers `opencode models --verbose` reports: the OpenCode Zen gateway, the
 * OpenCode Go subscription gateway, and the Anthropic and OpenAI providers
 * OpenCode can address directly with the user's own credentials.
 */
export const OPENCODE_PREDEFINED_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    { value: 'opencode/gpt-5.6-sol', label: 'GPT 5.6 Sol', description: 'OpenCode Zen' },
    { value: 'opencode/gpt-5.6-terra', label: 'GPT 5.6 Terra', description: 'OpenCode Zen' },
    { value: 'opencode/gpt-5.6-luna', label: 'GPT 5.6 Luna', description: 'OpenCode Zen' },
    { value: 'opencode/gpt-5.5', label: 'GPT 5.5', description: 'OpenCode Zen' },
    { value: 'opencode/gpt-5.5-pro', label: 'GPT 5.5 Pro', description: 'OpenCode Zen' },
    { value: 'opencode/gpt-5.4', label: 'GPT 5.4', description: 'OpenCode Zen' },
    { value: 'opencode/gpt-5.4-pro', label: 'GPT 5.4 Pro', description: 'OpenCode Zen' },
    { value: 'opencode/gpt-5.4-mini', label: 'GPT 5.4 Mini', description: 'OpenCode Zen' },
    { value: 'opencode/gpt-5.4-nano', label: 'GPT 5.4 Nano', description: 'OpenCode Zen' },
    { value: 'opencode/gpt-5.3-codex', label: 'GPT 5.3 Codex', description: 'OpenCode Zen' },
    { value: 'opencode/gpt-5.3-codex-spark', label: 'GPT 5.3 Codex Spark', description: 'OpenCode Zen' },
    { value: 'opencode/gpt-5.2', label: 'GPT 5.2', description: 'OpenCode Zen' },
    { value: 'opencode/gpt-5.1', label: 'GPT 5.1', description: 'OpenCode Zen' },
    { value: 'opencode/gpt-5', label: 'GPT 5', description: 'OpenCode Zen' },
    { value: 'opencode/gpt-5-nano', label: 'GPT 5 Nano', description: 'OpenCode Zen' },
    { value: 'opencode/claude-fable-5', label: 'Claude Fable 5', description: 'OpenCode Zen' },
    { value: 'opencode/claude-opus-5', label: 'Claude Opus 5', description: 'OpenCode Zen' },
    { value: 'opencode/claude-opus-4-8', label: 'Claude Opus 4.8', description: 'OpenCode Zen' },
    { value: 'opencode/claude-opus-4-7', label: 'Claude Opus 4.7', description: 'OpenCode Zen' },
    { value: 'opencode/claude-opus-4-6', label: 'Claude Opus 4.6', description: 'OpenCode Zen' },
    { value: 'opencode/claude-opus-4-5', label: 'Claude Opus 4.5', description: 'OpenCode Zen' },
    { value: 'opencode/claude-sonnet-5', label: 'Claude Sonnet 5', description: 'OpenCode Zen' },
    { value: 'opencode/claude-sonnet-4-6', label: 'Claude Sonnet 4.6', description: 'OpenCode Zen' },
    { value: 'opencode/claude-sonnet-4-5', label: 'Claude Sonnet 4.5', description: 'OpenCode Zen' },
    { value: 'opencode/claude-haiku-4-5', label: 'Claude Haiku 4.5', description: 'OpenCode Zen' },
    { value: 'opencode/gemini-3.6-flash', label: 'Gemini 3.6 Flash', description: 'OpenCode Zen' },
    { value: 'opencode/gemini-3.5-flash', label: 'Gemini 3.5 Flash', description: 'OpenCode Zen' },
    { value: 'opencode/gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite', description: 'OpenCode Zen' },
    { value: 'opencode/gemini-3.1-pro', label: 'Gemini 3.1 Pro', description: 'OpenCode Zen' },
    { value: 'opencode/gemini-3-flash', label: 'Gemini 3 Flash', description: 'OpenCode Zen' },
    { value: 'opencode/grok-4.5', label: 'Grok 4.5', description: 'OpenCode Zen' },
    { value: 'opencode/grok-build-0.1', label: 'Grok Build 0.1', description: 'OpenCode Zen' },
    { value: 'opencode/qwen3.7-max', label: 'Qwen3.7 Max', description: 'OpenCode Zen' },
    { value: 'opencode/qwen3.7-plus', label: 'Qwen3.7 Plus', description: 'OpenCode Zen' },
    { value: 'opencode/qwen3.6-plus', label: 'Qwen3.6 Plus', description: 'OpenCode Zen' },
    { value: 'opencode/qwen3.5-plus', label: 'Qwen3.5 Plus', description: 'OpenCode Zen' },
    { value: 'opencode/deepseek-v4-pro', label: 'DeepSeek V4 Pro', description: 'OpenCode Zen' },
    { value: 'opencode/deepseek-v4-flash', label: 'DeepSeek V4 Flash', description: 'OpenCode Zen' },
    { value: 'opencode/minimax-m3', label: 'MiniMax M3', description: 'OpenCode Zen' },
    { value: 'opencode/minimax-m2.7', label: 'MiniMax M2.7', description: 'OpenCode Zen' },
    { value: 'opencode/minimax-m2.5', label: 'MiniMax M2.5', description: 'OpenCode Zen' },
    { value: 'opencode/glm-5.2', label: 'GLM 5.2', description: 'OpenCode Zen' },
    { value: 'opencode/glm-5.1', label: 'GLM 5.1', description: 'OpenCode Zen' },
    { value: 'opencode/kimi-k2.5', label: 'Kimi K2.5', description: 'OpenCode Zen' },
    { value: 'opencode/kimi-k2.6', label: 'Kimi K2.6', description: 'OpenCode Zen' },
    { value: 'opencode/kimi-k2.7-code', label: 'Kimi K2.7 Code', description: 'OpenCode Zen' },
    { value: 'opencode/kimi-k3', label: 'Kimi K3', description: 'OpenCode Zen' },
    { value: 'opencode/big-pickle', label: 'Big Pickle', description: 'OpenCode Zen · Free' },
    { value: 'opencode/mimo-v2.5-free', label: 'MiMo-V2.5 Free', description: 'OpenCode Zen · Free' },
    { value: 'opencode/laguna-s-2.1-free', label: 'Laguna S 2.1 Free', description: 'OpenCode Zen · Free' },
    { value: 'opencode/ling-3.0-flash-free', label: 'Ling-3.0-flash Free', description: 'OpenCode Zen · Free' },
    { value: 'opencode/north-mini-code-free', label: 'North Mini Code Free', description: 'OpenCode Zen · Free' },
    { value: 'opencode/nemotron-3-ultra-free', label: 'Nemotron 3 Ultra Free', description: 'OpenCode Zen · Free' },
    { value: 'opencode/deepseek-v4-flash-free', label: 'DeepSeek V4 Flash Free', description: 'OpenCode Zen · Free' },
    {
      value: 'opencode-go/grok-4.6',
      label: 'Grok 4.6',
      description: 'OpenCode Go',
      effort: {
        values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }],
      },
    },
    {
      value: 'opencode-go/glm-5.3-flash',
      label: 'GLM 5.3 Flash',
      description: 'OpenCode Go',
      effort: {
        values: [{ value: 'low' }, { value: 'high' }, { value: 'max' }],
      },
    },
    {
      value: 'opencode-go/glm-5.3',
      label: 'GLM 5.3',
      description: 'OpenCode Go',
      effort: {
        values: [{ value: 'low' }, { value: 'high' }, { value: 'max' }],
      },
    },
    {
      value: 'opencode-go/glm-5.2',
      label: 'GLM 5.2',
      description: 'OpenCode Go',
      effort: {
        values: [{ value: 'high' }, { value: 'max' }],
      },
    },
    { value: 'opencode-go/glm-5.1', label: 'GLM 5.1', description: 'OpenCode Go' },
    {
      value: 'opencode-go/gpt-5.6-luna',
      label: 'GPT 5.6 Luna',
      description: 'OpenCode Go',
      effort: {
        values: [
          { value: 'none' },
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'opencode-go/kimi-k3',
      label: 'Kimi K3',
      description: 'OpenCode Go',
      effort: {
        values: [{ value: 'max' }],
      },
    },
    { value: 'opencode-go/kimi-k2.7-code', label: 'Kimi K2.7 Code', description: 'OpenCode Go' },
    { value: 'opencode-go/kimi-k2.6', label: 'Kimi K2.6', description: 'OpenCode Go' },
    {
      value: 'opencode-go/longcat-2.0',
      label: 'LongCat 2.0',
      description: 'OpenCode Go',
      effort: {
        values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }],
      },
    },
    { value: 'opencode-go/mimo-v2.5', label: 'MiMo V2.5', description: 'OpenCode Go' },
    { value: 'opencode-go/mimo-v2.5-pro', label: 'MiMo V2.5 Pro', description: 'OpenCode Go' },
    {
      value: 'opencode-go/minimax-m3',
      label: 'MiniMax M3',
      description: 'OpenCode Go',
      effort: {
        values: [{ value: 'none' }, { value: 'thinking' }],
      },
    },
    { value: 'opencode-go/minimax-m2.7', label: 'MiniMax M2.7', description: 'OpenCode Go' },
    {
      value: 'opencode-go/muse-spark-1.3-contributor',
      label: 'Muse Spark 1.3 Contributor',
      description: 'OpenCode Go',
      effort: {
        values: [
          { value: 'minimal' },
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
        ],
      },
    },
    {
      value: 'opencode-go/muse-spark-1.2-contributor',
      label: 'Muse Spark 1.2 Contributor',
      description: 'OpenCode Go',
      effort: {
        values: [
          { value: 'minimal' },
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
        ],
      },
    },
    {
      value: 'opencode-go/qwen3.8-max',
      label: 'Qwen3.8 Max',
      description: 'OpenCode Go',
      effort: {
        values: [{ value: 'low' }, { value: 'medium' }, { value: 'xhigh' }],
      },
    },
    {
      value: 'opencode-go/qwen3.8-flash',
      label: 'Qwen3.8 Flash',
      description: 'OpenCode Go',
      effort: {
        values: [{ value: 'low' }, { value: 'medium' }, { value: 'xhigh' }],
      },
    },
    { value: 'opencode-go/qwen3.7-max', label: 'Qwen3.7 Max', description: 'OpenCode Go' },
    { value: 'opencode-go/qwen3.7-plus', label: 'Qwen3.7 Plus', description: 'OpenCode Go' },
    { value: 'opencode-go/qwen3.6-plus', label: 'Qwen3.6 Plus', description: 'OpenCode Go' },
    {
      value: 'opencode-go/deepseek-v4-pro',
      label: 'DeepSeek V4 Pro',
      description: 'OpenCode Go',
      effort: {
        values: [{ value: 'high' }, { value: 'max' }],
      },
    },
    {
      value: 'opencode-go/deepseek-v4-flash',
      label: 'DeepSeek V4 Flash',
      description: 'OpenCode Go',
      effort: {
        values: [{ value: 'low' }, { value: 'high' }, { value: 'max' }],
      },
    },
    {
      value: 'opencode-go/deepseek-v4-flash-vision-exp',
      label: 'DeepSeek V4 Flash Vision Exp',
      description: 'OpenCode Go',
      effort: {
        values: [{ value: 'low' }, { value: 'high' }, { value: 'max' }],
      },
    },
    {
      value: 'opencode-go/hy4-preview',
      label: 'Hy4 Preview',
      description: 'OpenCode Go',
      effort: {
        values: [{ value: 'none' }, { value: 'high' }],
      },
    },
    {
      value: 'opencode-go/hy3',
      label: 'Hy3',
      description: 'OpenCode Go',
      effort: {
        values: [{ value: 'none' }, { value: 'low' }, { value: 'high' }],
      },
    },
    {
      value: 'opencode-go/omen-alpha',
      label: 'Omen Alpha',
      description: 'OpenCode Go',
      effort: {
        values: [{ value: 'low' }, { value: 'high' }],
      },
    },
    { value: 'anthropic/claude-opus-5', label: 'Claude Opus 5', description: 'Anthropic' },
    { value: 'anthropic/claude-opus-5-fast', label: 'Claude Opus 5 Fast', description: 'Anthropic' },
    { value: 'anthropic/claude-fable-5', label: 'Claude Fable 5', description: 'Anthropic' },
    { value: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5', description: 'Anthropic' },
    { value: 'anthropic/claude-opus-4-8', label: 'Claude Opus 4.8', description: 'Anthropic' },
    { value: 'anthropic/claude-opus-4-8-fast', label: 'Claude Opus 4.8 Fast', description: 'Anthropic' },
    { value: 'anthropic/claude-opus-4-7', label: 'Claude Opus 4.7', description: 'Anthropic' },
    { value: 'anthropic/claude-opus-4-7-fast', label: 'Claude Opus 4.7 Fast', description: 'Anthropic' },
    { value: 'anthropic/claude-opus-4-6', label: 'Claude Opus 4.6', description: 'Anthropic' },
    { value: 'anthropic/claude-opus-4-6-fast', label: 'Claude Opus 4.6 Fast', description: 'Anthropic' },
    { value: 'anthropic/claude-opus-4-5', label: 'Claude Opus 4.5 (latest)', description: 'Anthropic' },
    { value: 'anthropic/claude-opus-4-5-20251101', label: 'Claude Opus 4.5', description: 'Anthropic' },
    { value: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6', description: 'Anthropic' },
    { value: 'anthropic/claude-sonnet-4-5', label: 'Claude Sonnet 4.5 (latest)', description: 'Anthropic' },
    { value: 'anthropic/claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5', description: 'Anthropic' },
    { value: 'anthropic/claude-haiku-4-5', label: 'Claude Haiku 4.5 (latest)', description: 'Anthropic' },
    { value: 'anthropic/claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', description: 'Anthropic' },
    { value: 'openai/gpt-5.6', label: 'GPT-5.6', description: 'OpenAI' },
    { value: 'openai/gpt-5.6-fast', label: 'GPT-5.6 Fast', description: 'OpenAI' },
    { value: 'openai/gpt-5.6-pro', label: 'GPT-5.6 Pro', description: 'OpenAI' },
    { value: 'openai/gpt-5.6-sol', label: 'GPT-5.6 Sol', description: 'OpenAI' },
    { value: 'openai/gpt-5.6-sol-fast', label: 'GPT-5.6 Sol Fast', description: 'OpenAI' },
    { value: 'openai/gpt-5.6-sol-pro', label: 'GPT-5.6 Sol Pro', description: 'OpenAI' },
    { value: 'openai/gpt-5.6-terra', label: 'GPT-5.6 Terra', description: 'OpenAI' },
    { value: 'openai/gpt-5.6-terra-fast', label: 'GPT-5.6 Terra Fast', description: 'OpenAI' },
    { value: 'openai/gpt-5.6-terra-pro', label: 'GPT-5.6 Terra Pro', description: 'OpenAI' },
    { value: 'openai/gpt-5.6-luna', label: 'GPT-5.6 Luna', description: 'OpenAI' },
    { value: 'openai/gpt-5.6-luna-fast', label: 'GPT-5.6 Luna Fast', description: 'OpenAI' },
    { value: 'openai/gpt-5.6-luna-pro', label: 'GPT-5.6 Luna Pro', description: 'OpenAI' },
    { value: 'openai/gpt-5.5', label: 'GPT-5.5', description: 'OpenAI' },
    { value: 'openai/gpt-5.5-fast', label: 'GPT-5.5 Fast', description: 'OpenAI' },
    { value: 'openai/gpt-5.4', label: 'GPT-5.4', description: 'OpenAI' },
    { value: 'openai/gpt-5.4-fast', label: 'GPT-5.4 Fast', description: 'OpenAI' },
    { value: 'openai/gpt-5.4-mini', label: 'GPT-5.4 mini', description: 'OpenAI' },
    { value: 'openai/gpt-5.4-mini-fast', label: 'GPT-5.4 mini Fast', description: 'OpenAI' },
    { value: 'openai/gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark', description: 'OpenAI' },
  ],
  DEFAULT: 'opencode/gpt-5.6-terra',
};

/** How long to wait for the OpenCode server before falling back to the curated catalog. */
const OPENCODE_SERVER_REQUEST_TIMEOUT_MS = 5_000;

/**
 * Maps one OpenCode model's `variants` map onto CloudCLI effort choices.
 *
 * The server reports variants as `{ <name>: { ...config } }`, where each key is
 * the `--variant` value CloudCLI passes to `opencode run` (for example `low`,
 * `high`, `max`). Variants flagged `disabled` are omitted so the picker never
 * offers a level the CLI would reject.
 */
const readOpenCodeEffortValues = (
  variants: unknown,
): NonNullable<ProviderModelOption['effort']>['values'] => {
  const record = readObjectRecord(variants);
  if (!record) {
    return [];
  }

  return Object.entries(record)
    .filter(([, config]) => readObjectRecord(config)?.disabled !== true)
    .map(([value]) => ({ value }));
};

/**
 * Reads the provider/model catalog from a running OpenCode server.
 *
 * The SDK's `config.providers` is the source the OpenCode client itself renders
 * from, so the models and their reasoning `variants` match the client exactly -
 * unlike the curated catalog, which only covers a subset. Returns null when the
 * server is unreachable or reports no models, so the caller keeps its fallback.
 */
const readOpenCodeServerModelOptions = async (instanceId?: string): Promise<ProviderModelOption[] | null> => {
  let payload: Record<string, unknown>;
  try {
    const client = createOpenCodeServerClient(instanceId ? findOpenCodeServerConfig(instanceId) : undefined);
    const result = await client.config.providers({}, {
      throwOnError: true,
      signal: AbortSignal.timeout(OPENCODE_SERVER_REQUEST_TIMEOUT_MS),
    });
    payload = readObjectRecord(result.data) ?? {};
  } catch {
    return null;
  }

  const providers = Array.isArray(payload.providers) ? payload.providers : [];
  const options: ProviderModelOption[] = [];

  for (const providerValue of providers) {
    const provider = readObjectRecord(providerValue);
    const providerId = readOptionalString(provider?.id);
    const models = readObjectRecord(provider?.models);
    if (!providerId || !models) {
      continue;
    }

    const providerLabel = readOptionalString(provider?.name) ?? providerId;
    for (const [modelId, modelValue] of Object.entries(models)) {
      const model = readObjectRecord(modelValue);
      if (!model) {
        continue;
      }

      const effortValues = readOpenCodeEffortValues(model.variants);
      options.push({
        value: `${providerId}/${modelId}`,
        label: readOptionalString(model.name) ?? modelId,
        description: providerLabel,
        ...(effortValues.length > 0 ? { effort: { values: effortValues } } : {}),
      });
    }
  }

  return options.length > 0 ? options : null;
};

const parseOpenCodeSessionModelValue = (rawModel: unknown): string | null => {
  if (typeof rawModel === 'string') {
    const trimmed = rawModel.trim();
    if (!trimmed) {
      return null;
    }

    try {
      return parseOpenCodeSessionModelValue(JSON.parse(trimmed));
    } catch {
      return trimmed;
    }
  }

  const record = readObjectRecord(rawModel);
  if (!record) {
    return null;
  }

  const providerId = readOptionalString(record.providerID);
  const modelId = readOptionalString(record.modelID) ?? readOptionalString(record.id);
  if (providerId && modelId) {
    return `${providerId}/${modelId}`;
  }

  return readOptionalString(record.id)
    ?? readOptionalString(record.model)
    ?? readOptionalString(record.name)
    ?? readOptionalString(record.value)
    ?? null;
};

/** Provider registry model adapter for OpenCode predefined models and session metadata. */
export class OpenCodeProviderModels implements IProviderModels {
  async getSupportedModels(instanceId?: string): Promise<ProviderModelsDefinition> {
    if (instanceId && !findOpenCodeServerConfig(instanceId)) {
      throw new Error('Selected OpenCode instance is unavailable.');
    }
    // The running server is the OpenCode client's own source of truth: its
    // catalog already covers every provider this install can route to, and its
    // reasoning `variants` match what the client shows. The curated catalog is
    // only a fallback for when the server cannot be reached.
    const serverOptions = await readOpenCodeServerModelOptions(instanceId);
    if (serverOptions) {
      return {
        OPTIONS: serverOptions,
        DEFAULT: serverOptions.some((option) => option.value === OPENCODE_PREDEFINED_MODELS.DEFAULT)
          ? OPENCODE_PREDEFINED_MODELS.DEFAULT
          : serverOptions[0].value,
      };
    }

    return OPENCODE_PREDEFINED_MODELS;
  }

  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    if (!sessionId?.trim()) {
      return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
    }

    // The server keys sessions by OpenCode's own id, so the stable app id has
    // to be translated first; sessions discovered on disk store the provider id
    // in both columns and resolve to themselves. The project path scopes the
    // lookup to the session's own project when the server hosts several.
    const session = sessionsDb.getSessionById(sessionId);
    const providerSessionId = session?.provider_session_id ?? sessionId;
    const directory = session?.project_path ?? undefined;

    // The owning server is the source of truth for a session's active model;
    // the curated default only covers sessions no server knows.
    const info = await readOpenCodeSessionInfo(providerSessionId, directory);
    const model = parseOpenCodeSessionModelValue(readObjectRecord(info)?.model);
    if (model) {
      return { model };
    }

    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }
}
