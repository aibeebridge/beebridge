import fs from "node:fs";
import path from "node:path";
import { atomicWriteJson, safeReadJson } from "../server/safe-fs.js";
import type {
  BeeAssignmentPolicy,
  PmAuthProfile,
  PmModelPolicy,
  PmSettings,
  ProviderAuthMode,
  ProviderCatalogItem,
} from "@beebridge/core";

function initialModelPolicy(catalog: ProviderCatalogItem[]): PmModelPolicy {
  const firstProvider = catalog[0];
  const firstModel = firstProvider?.models[0] ?? "gpt-4o";
  return {
    defaultProviderId: firstProvider?.id ?? "openai",
    defaultModel: firstModel,
    allowedModels: [firstModel],
  };
}

function initialBeePolicy(): BeeAssignmentPolicy {
  return {
    defaultFlowerType: "web",
    providerToBee: {
      openai: "worker-bee-gpt",
      anthropic: "worker-bee-claude",
      google: "worker-bee-gemini",
      xai: "worker-bee-grok",
      openrouter: "worker-bee-router",
      "github-copilot": "worker-bee-copilot",
    },
  };
}

export class PmSettingsStore {
  private settings: PmSettings;
  private readonly dataDir: string;
  private readonly settingsFile: string;

  constructor(private readonly providerCatalog: ProviderCatalogItem[], dataRoot: string) {
    this.dataDir = dataRoot;
    this.settingsFile = path.join(dataRoot, "pm-settings.json");
    const loaded = this.loadFromDisk();
    if (loaded) {
      this.settings = loaded;
    } else {
      this.settings = {
        authProfiles: [],
        modelPolicy: initialModelPolicy(providerCatalog),
        beePolicy: initialBeePolicy(),
      };
    }
  }

  public get(): PmSettings {
    return structuredClone(this.settings);
  }

  public listProfiles(): PmAuthProfile[] {
    return this.settings.authProfiles.map((profile) => ({ ...profile, secret: this.maskSecret(profile.secret) }));
  }

  public addProfile(input: {
    providerId: string;
    mode: ProviderAuthMode;
    secret: string;
    label?: string;
  }): PmAuthProfile {
    const profile: PmAuthProfile = {
      id: `profile-${Date.now()}`,
      providerId: input.providerId,
      mode: input.mode,
      secret: input.secret,
      label: input.label,
      active: this.settings.authProfiles.length === 0,
      createdAt: new Date().toISOString(),
    };
    this.settings.authProfiles.push(profile);
    this.saveToDisk();
    return { ...profile, secret: this.maskSecret(profile.secret) };
  }

  public activateProfile(profileId: string): PmAuthProfile | undefined {
    let activated: PmAuthProfile | undefined;
    for (const profile of this.settings.authProfiles) {
      profile.active = profile.id === profileId;
      if (profile.active) {
        activated = profile;
      }
    }
    if (!activated) return undefined;
    this.saveToDisk();
    return { ...activated, secret: this.maskSecret(activated.secret) };
  }

  /** Updates stored secret (e.g. refreshed OAuth bundle). Returns masked profile or undefined if id missing. */
  public updateProfileSecret(profileId: string, secret: string): PmAuthProfile | undefined {
    const profile = this.settings.authProfiles.find((p) => p.id === profileId);
    if (!profile) return undefined;
    profile.secret = secret;
    this.saveToDisk();
    return { ...profile, secret: this.maskSecret(profile.secret) };
  }

  public removeProfile(profileId: string): boolean {
    const index = this.settings.authProfiles.findIndex((profile) => profile.id === profileId);
    if (index < 0) return false;
    const wasActive = this.settings.authProfiles[index]?.active;
    this.settings.authProfiles.splice(index, 1);
    if (wasActive && this.settings.authProfiles.length > 0) {
      this.settings.authProfiles[0].active = true;
    }
    this.saveToDisk();
    return true;
  }

  public clearProfiles(): number {
    const removedCount = this.settings.authProfiles.length;
    if (removedCount === 0) return 0;
    this.settings.authProfiles = [];
    this.saveToDisk();
    return removedCount;
  }

  public getActiveProfile(): PmAuthProfile | undefined {
    return this.settings.authProfiles.find((profile) => profile.active);
  }

  public setModelPolicy(next: Partial<PmModelPolicy>): PmModelPolicy {
    this.settings.modelPolicy = {
      ...this.settings.modelPolicy,
      ...next,
      allowedModels: next.allowedModels ?? this.settings.modelPolicy.allowedModels,
    };
    this.saveToDisk();
    return { ...this.settings.modelPolicy };
  }

  public getModelPolicy(): PmModelPolicy {
    return { ...this.settings.modelPolicy };
  }

  public getCatalog(): ProviderCatalogItem[] {
    return structuredClone(this.providerCatalog);
  }

  private maskSecret(secret: string): string {
    if (!secret) return "";
    if (secret.length <= 6) return "*".repeat(secret.length);
    return `${secret.slice(0, 3)}${"*".repeat(secret.length - 6)}${secret.slice(-3)}`;
  }

  private saveToDisk(): void {
    try {
      atomicWriteJson(this.settingsFile, this.settings);
    } catch {
      // silent fail — persistence is best-effort
    }
  }

  private loadFromDisk(): PmSettings | null {
    const data = safeReadJson<PmSettings | null>(this.settingsFile, null);
    if (!data?.authProfiles || !data?.modelPolicy || !data?.beePolicy) return null;
    return data;
  }
}
