import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import TOML from '@iarna/toml';

import { codexAppServer } from '@/modules/providers/list/codex/codex-app-server.client.js';
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

/** Curated Codex catalog shipped as immutable CloudCLI defaults. */
export const CODEX_PREDEFINED_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'gpt-6-astra',
      label: 'GPT-6 Astra',
      description: 'Our most capable model for complex, demanding work.',
      effort: {
        default: 'low',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          { value: 'ultra' },
        ],
      },
    },
    {
      value: 'gpt-6-sol',
      label: 'GPT-6 Sol',
      description: 'Workhorse model for coding and everyday work.',
      effort: {
        default: 'medium',
        values: [
          { value: 'low' }, { value: 'medium' }, { value: 'high' },
          { value: 'xhigh' }, { value: 'max' }, { value: 'ultra' },
        ],
      },
    },
    {
      value: 'gpt-6-luna',
      label: 'GPT-6 Luna',
      description: 'Fast and affordable model for easier tasks.',
      effort: {
        default: 'medium',
        values: [
          { value: 'low' }, { value: 'medium' }, { value: 'high' },
          { value: 'xhigh' }, { value: 'max' },
        ],
      },
    },
    {
      value: 'gpt-5.6-sol',
      label: 'GPT-5.6 Sol',
      description: 'Latest frontier agentic coding model.',
      effort: {
        default: 'low',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          { value: 'ultra' },
        ],
      },
    },
    {
      value: 'gpt-5.6-terra',
      label: 'GPT-5.6 Terra',
      description: 'Balanced agentic coding model for everyday work.',
      effort: {
        default: 'medium',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          { value: 'ultra' },
        ],
      },
    },
    {
      value: 'gpt-5.6-luna',
      label: 'GPT-5.6 Luna',
      description: 'Fast and affordable agentic coding model.',
      effort: {
        default: 'medium',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'gpt-5.5',
      label: 'GPT-5.5',
      description: 'Frontier model for complex coding, research, and real-world work.',
      effort: {
        default: 'medium',
        values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }],
      },
    },
    {
      value: 'gpt-5.4',
      label: 'GPT-5.4',
      description: 'Strong model for everyday coding.',
      effort: {
        default: 'medium',
        values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }],
      },
    },
    {
      value: 'gpt-5.4-mini',
      label: 'GPT-5.4 Mini',
      description: 'Small, fast, and cost-efficient model for simpler coding tasks.',
      effort: {
        default: 'medium',
        values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }],
      },
    },
  ],
  DEFAULT: 'gpt-6-sol',
};

const CODEX_CONFIG_PATH = path.join(os.homedir(), '.codex', 'config.toml');

/** Provider registry model adapter for Codex predefined models and active config. */
export class CodexProviderModels implements IProviderModels {
  private catalogPromise: Promise<ProviderModelsDefinition> | null = null;

  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    this.catalogPromise ??= this.loadSupportedModels();
    return this.catalogPromise;
  }

  private async loadSupportedModels(): Promise<ProviderModelsDefinition> {
    try {
      const rawModels = await codexAppServer.listModels();
      const options: ProviderModelOption[] = rawModels.flatMap((rawModel) => {
        if (!rawModel || typeof rawModel !== 'object') return [];
        const model = rawModel as Record<string, unknown>;
        const value = typeof model.id === 'string' ? model.id : '';
        if (!value || model.hidden === true) return [];

        const effort = Array.isArray(model.supportedReasoningEfforts)
          ? model.supportedReasoningEfforts.flatMap((item) => {
              if (!item || typeof item !== 'object') return [];
              const reasoningEffort = (item as Record<string, unknown>).reasoningEffort;
              return typeof reasoningEffort === 'string' ? [{ value: reasoningEffort }] : [];
            })
          : [];
        const option: ProviderModelOption = {
          value,
          label: typeof model.displayName === 'string' ? model.displayName : value,
          description: typeof model.description === 'string' ? model.description : undefined,
          effort: effort.length > 0
            ? {
                default: typeof model.defaultReasoningEffort === 'string'
                  ? model.defaultReasoningEffort
                  : 'default',
                values: effort,
              }
            : undefined,
        };
        return [option];
      });

      if (options.length === 0) return CODEX_PREDEFINED_MODELS;
      const defaultValue = rawModels.find((model) => (
        Boolean(model && typeof model === 'object' && (model as Record<string, unknown>).isDefault === true)
      ));
      const configuredModel = await readConfiguredModel();
      const configuredDefault = configuredModel && options.some((option) => option.value === configuredModel)
        ? configuredModel
        : null;
      const detectedDefault = defaultValue && typeof defaultValue === 'object'
        ? (defaultValue as Record<string, unknown>).id
        : null;
      const defaultModel = configuredDefault
        ? configuredDefault
        : typeof detectedDefault === 'string' && options.some((option) => option.value === detectedDefault)
          ? detectedDefault
          : options[0].value;
      return { OPTIONS: options, DEFAULT: defaultModel };
    } catch {
      return CODEX_PREDEFINED_MODELS;
    }
  }

  async getCurrentActiveModel(): Promise<ProviderCurrentActiveModel> {
    try {
      const model = await readConfiguredModel();
      if (!model) {
        return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
      }

      return {
        model,
      };
    } catch {
      return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
    }
  }
}

async function readConfiguredModel(): Promise<string | null> {
  try {
    const raw = await readFile(CODEX_CONFIG_PATH, 'utf8');
    const parsed = readObjectRecord(TOML.parse(raw));
    return readOptionalString(parsed?.model) ?? null;
  } catch {
    return null;
  }
}
