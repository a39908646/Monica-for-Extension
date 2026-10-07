<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { tr } from "../i18n";
import { vaultClient } from "../runtime/client";
import type { VaultTimeoutPolicy, VaultTimeoutSettings } from "../core/model";

/** Bitwarden-compatible session timeout choices; custom durations map onto the minutes policy. */
const TIMEOUT_CHOICES = ["immediate", "1", "5", "15", "30", "60", "240", "browser-restart", "never", "custom"] as const;
type TimeoutChoice = typeof TIMEOUT_CHOICES[number];
type CustomUnit = "minutes" | "hours" | "days";

const choice = ref<TimeoutChoice>("15");
const customValue = ref(15);
const customUnit = ref<CustomUnit>("minutes");
const current = ref<VaultTimeoutSettings>({ policy: "minutes", minutes: 15 });
const ready = ref(false);
const busy = ref(false);
const error = ref("");
const savedNotice = ref(false);

const pending = computed<VaultTimeoutSettings>(() => {
  if (choice.value === "custom") return { policy: "minutes", minutes: customMinutes() };
  if (/^\d+$/.test(choice.value)) return { policy: "minutes", minutes: Number(choice.value) };
  return { policy: choice.value as VaultTimeoutPolicy, minutes: current.value.minutes };
});
const dirty = computed(() => pending.value.policy !== current.value.policy || pending.value.minutes !== current.value.minutes);
const warning = computed(() => current.value.policy === "browser-restart" || current.value.policy === "never");
const customMax = computed(() => customUnit.value === "days" ? 1 : customUnit.value === "hours" ? 24 : 1440);

function customMinutes(): number {
  const factor = customUnit.value === "days" ? 1440 : customUnit.value === "hours" ? 60 : 1;
  const value = Math.round(Number(customValue.value) || 0);
  return Math.min(Math.max(value * factor, 1), 1440);
}

function apply(settings: VaultTimeoutSettings): void {
  current.value = settings;
  savedNotice.value = false;
  error.value = "";
  if (settings.policy !== "minutes") {
    choice.value = settings.policy;
    return;
  }
  const preset = String(settings.minutes);
  if ((TIMEOUT_CHOICES as readonly string[]).includes(preset) && preset !== "custom") {
    choice.value = preset as TimeoutChoice;
    return;
  }
  choice.value = "custom";
  if (settings.minutes % 1440 === 0) { customUnit.value = "days"; customValue.value = settings.minutes / 1440; }
  else if (settings.minutes % 60 === 0) { customUnit.value = "hours"; customValue.value = settings.minutes / 60; }
  else { customUnit.value = "minutes"; customValue.value = settings.minutes; }
}

function choiceLabel(value: string): string {
  if (value === "immediate") return tr('立即');
  if (value === "browser-restart") return tr('浏览器重启时');
  if (value === "never") return tr('从不');
  if (value === "custom") return tr('自定义');
  const minutes = Number(value);
  return minutes >= 60 ? tr('{0} 小时', { 0: minutes / 60 }) : tr('{0} 分钟', { 0: minutes });
}

function timeoutSummary(settings: VaultTimeoutSettings): string {
  if (settings.policy === "immediate") return tr('关闭 Monica 界面后立即锁定');
  if (settings.policy === "browser-restart") return tr('浏览器重启时锁定');
  if (settings.policy === "never") return tr('从不自动锁定');
  return settings.minutes >= 60 && settings.minutes % 60 === 0
    ? tr('{0} 小时无操作后锁定', { 0: settings.minutes / 60 })
    : tr('{0} 分钟无操作后锁定', { 0: settings.minutes });
}

function failureMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

async function save(): Promise<void> {
  if (busy.value || !dirty.value) return;
  busy.value = true;
  error.value = "";
  savedNotice.value = false;
  try {
    apply(await vaultClient.setVaultTimeoutSettings(pending.value));
    savedNotice.value = true;
  } catch (cause) {
    error.value = failureMessage(cause, tr('未能保存会话超时设置，请重试。'));
  } finally {
    busy.value = false;
  }
}

onMounted(async () => {
  try {
    apply(await vaultClient.getVaultTimeoutSettings());
  } catch (cause) {
    error.value = failureMessage(cause, tr('未能读取会话超时设置。'));
  } finally {
    ready.value = true;
  }
});
</script>

<template>
  <section class="vault-timeout" aria-labelledby="vault-timeout-label">
    <div class="vault-timeout-head">
      <span class="vault-timeout-icon" aria-hidden="true"><m3e-icon name="schedule"></m3e-icon></span>
      <div>
        <strong id="vault-timeout-label">{{ tr('会话超时') }}</strong>
        <p>{{ timeoutSummary(current) }}</p>
      </div>
    </div>
    <p class="vault-timeout-description">{{ tr('自动锁定密码库前等待的时间。') }}</p>
    <label class="vault-timeout-field">
      <span>{{ tr('超时时间') }}</span>
      <select v-model="choice" :disabled="!ready || busy" :aria-label="tr('超时时间')">
        <option v-for="value in TIMEOUT_CHOICES" :key="value" :value="value">{{ choiceLabel(value) }}</option>
      </select>
    </label>
    <div v-if="choice === 'custom'" class="vault-timeout-custom">
      <label>
        <span>{{ tr('自定义时长') }}</span>
        <input v-model.number="customValue" type="number" min="1" :max="customMax" inputmode="numeric" :disabled="busy" :aria-label="tr('自定义时长')" />
      </label>
      <label>
        <span>{{ tr('单位') }}</span>
        <select v-model="customUnit" :disabled="busy" :aria-label="tr('单位')">
          <option value="minutes">{{ tr('分钟') }}</option>
          <option value="hours">{{ tr('小时') }}</option>
          <option value="days">{{ tr('天') }}</option>
        </select>
      </label>
    </div>
    <p v-if="warning" class="vault-timeout-warning" role="alert">{{ tr('选择「浏览器重启时」或「从不」后，会话密钥会保存在浏览器本地存储中；同一台电脑上的其他程序或用户可以直接解密密码库。') }}</p>
    <p v-else class="vault-timeout-note">{{ tr('其他选项只把会话密钥保存在浏览器会话存储中，关闭浏览器后自动清除。') }}</p>
    <div class="vault-timeout-actions">
      <m3e-button variant="tonal" type="button" :disabled="!ready || busy || !dirty" @click="save">{{ busy ? tr('正在保存…') : tr('保存设置') }}</m3e-button>
      <span v-if="savedNotice" class="vault-timeout-saved" role="status">{{ tr('会话超时设置已保存。') }}</span>
    </div>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.vault-timeout { display: grid; gap: 12px; padding: 16px; }
.vault-timeout-head { display: flex; gap: 12px; align-items: center; }
.vault-timeout-icon { display: grid; place-items: center; width: 44px; height: 44px; flex: 0 0 44px; border-radius: 8px; background: var(--app-surface-high); }
.vault-timeout-head strong { font-size: 1rem; font-weight: 600; overflow-wrap: anywhere; }
.vault-timeout-head p { margin: 4px 0 0; font-size: .875rem; color: var(--app-muted); overflow-wrap: anywhere; }
.vault-timeout-description, .vault-timeout-note, .vault-timeout-warning { margin: 0; font-size: .8125rem; line-height: 1.6; overflow-wrap: anywhere; }
.vault-timeout-description, .vault-timeout-note { color: var(--app-muted); }
.vault-timeout-warning { padding: 10px 12px; border-radius: 8px; color: var(--app-error, #ba151c); background: var(--app-surface-high); }
.vault-timeout-field, .vault-timeout-custom label { display: grid; gap: 6px; font-size: .8125rem; }
.vault-timeout-field > span, .vault-timeout-custom label > span { color: var(--app-muted); }
.vault-timeout select, .vault-timeout input { min-height: 44px; padding: 0 10px; border: 1px solid var(--app-outline); border-radius: 8px; color: inherit; background: var(--app-surface, transparent); font: inherit; }
.vault-timeout-custom { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
.vault-timeout-actions { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
.vault-timeout-saved { font-size: .8125rem; color: var(--app-muted); }
.vault-timeout :deep(.form-error) { margin: 0; font-size: .8125rem; }
@media (max-width: 560px) { .vault-timeout-custom { grid-template-columns: 1fr; } }
</style>
