<script setup lang="ts">
import { tr } from '../i18n';

import { reactive, ref, watch } from "vue";
import {
  CONTENT_BLOCK_KINDS,
  contentBlockEditableKeys,
  contentBlockFieldIsSecret,
  contentBlockFieldLabel,
  contentBlockFromDraft,
  contentBlockKindLabel,
  contentBlockToken,
  contentBlockValue,
  resolveContentBlockQrText,
  type ContentBlockDraft,
  type ContentBlockKind,
  type ContentBlockQrValues,
  type StoredContentBlock
} from "../core/password-content-blocks";
import { createQrDataUrl } from "../core/otp-qr";

const props = defineProps<{
  /** 可编辑的内容块草稿，父级持有；本组件只修改草稿字段并回报增删与排序。 */
  blocks: ContentBlockDraft[];
  /** 无法解析的块：只提示原内容已保留，不允许在扩展里覆盖或删除。 */
  damaged: StoredContentBlock[];
  /** 二维码模板（`%ACCOUNT%` 等）在编辑器当前取值上的展开依据。 */
  qrValues: ContentBlockQrValues;
}>();
const emit = defineEmits<{ add: [kind: ContentBlockKind]; remove: [id: string]; move: [index: number, delta: number] }>();

const qrImages = ref<Record<string, string>>({});
const qrFailed = ref<Record<string, boolean>>({});
const qrBusy = reactive(new Set<string>());
const oversized = ref<Record<string, boolean>>({});

// 草稿变化后旧二维码图片失效，避免展示与字段不一致的二维码。
watch(() => props.blocks.map((block) => JSON.stringify([block.id, block.title, block.values])), () => {
  qrImages.value = {};
  qrFailed.value = {};
  const next: Record<string, boolean> = {};
  for (const block of props.blocks) next[block.id] = isOversized(block);
  oversized.value = next;
}, { immediate: true, deep: true });

/** 与 Android 的 256 KiB 上限一致：超限时明确提示，不静默截断。 */
function isOversized(block: ContentBlockDraft): boolean {
  try {
    return new TextEncoder().encode(JSON.stringify(contentBlockFromDraft(block).envelope)).byteLength > 256 * 1024;
  } catch {
    return true;
  }
}

function isLongField(kind: ContentBlockKind, key: string): boolean {
  return ["publicKeyOpenSsh", "privateKeyOpenSsh", "publicKey", "privateKey", "content", "notes"].includes(key);
}

function previewQr(block: ContentBlockDraft) {
  if (qrBusy.has(block.id)) return;
  const text = resolveContentBlockQrText(contentBlockFromDraft(block), props.qrValues);
  if (!text) return void (qrFailed.value = { ...qrFailed.value, [block.id]: true });
  qrBusy.add(block.id);
  void createQrDataUrl(text).then((image) => {
    qrImages.value = { ...qrImages.value, [block.id]: image };
  }).catch(() => {
    qrFailed.value = { ...qrFailed.value, [block.id]: true };
  }).finally(() => qrBusy.delete(block.id));
}

function blockValue(block: ContentBlockDraft, key: string): string {
  return block.values[key] || "";
}

function setBlockValue(block: ContentBlockDraft, key: string, value: string) {
  block.values[key] = value;
}

/** 供父级在保存前检查：超限块不得写入。 */
defineExpose({
  oversizedBlocks: () => props.blocks.filter((block) => oversized.value[block.id]).map((block) => block.id)
});
</script>

<template>
  <fieldset class="editor-fieldset field-wide content-block-editor">
    <legend>{{ tr('内容块') }}</legend>
    <p class="editor-intro">{{ tr('内容块与 Monica Android 端共用受保护字段，扩展只编辑其中的字段值。') }}</p>

    <div v-if="damaged.length" class="content-block-damaged" role="status">
      <strong>{{ tr('暂无法解析的内容') }}</strong>
      <span>{{ tr('原始内容已保留，请使用兼容版本编辑。') }}</span>
    </div>

    <article v-for="(block, index) in blocks" :key="block.id" class="content-block-card">
      <header class="content-block-card-head">
        <strong>{{ tr(contentBlockKindLabel(block.kind)) }}</strong>
        <span class="content-block-card-actions">
          <m3e-icon-button :aria-label="tr('上移')" :disabled="index === 0" @click="emit('move', index, -1)"><m3e-icon name="expand_less"></m3e-icon></m3e-icon-button>
          <m3e-icon-button :aria-label="tr('下移')" :disabled="index === blocks.length - 1" @click="emit('move', index, 1)"><m3e-icon name="expand_more"></m3e-icon></m3e-icon-button>
          <m3e-icon-button :aria-label="tr('删除内容块')" @click="emit('remove', block.id)"><m3e-icon name="delete"></m3e-icon></m3e-icon-button>
        </span>
      </header>

      <div class="content-block-fields">
        <label class="field field-wide"><span>{{ tr('标题') }}</span><input v-model="block.title" autocomplete="off" :placeholder="tr(contentBlockKindLabel(block.kind))" /></label>
        <label v-for="key in contentBlockEditableKeys(block.kind)" :key="key" class="field" :class="{ 'field-wide': isLongField(block.kind, key) }">
          <span>{{ tr(contentBlockFieldLabel(key)) }}</span>
          <textarea v-if="isLongField(block.kind, key)" rows="3" spellcheck="false" :value="blockValue(block, key)" @input="setBlockValue(block, key, ($event.target as HTMLTextAreaElement).value)"></textarea>
          <input v-else :type="contentBlockFieldIsSecret(key) ? 'password' : 'text'" autocomplete="off" spellcheck="false" :value="blockValue(block, key)" @input="setBlockValue(block, key, ($event.target as HTMLInputElement).value)" />
        </label>
      </div>

      <div v-if="block.kind === 'QR_CODE'" class="content-block-qr">
        <img v-if="qrImages[block.id]" class="detail-qr" :src="qrImages[block.id]" :alt="tr('二维码')" width="240" height="240" />
        <m3e-button v-else-if="!qrFailed[block.id]" variant="tonal" type="button" :disabled="qrBusy.has(block.id)" @click="previewQr(block)">{{ qrBusy.has(block.id) ? tr('处理中…') : tr('查看二维码') }}</m3e-button>
        <span v-else class="supporting">{{ tr('此内容超出二维码容量，仍可完整查看或复制。') }}</span>
      </div>

      <p v-if="oversized[block.id]" class="form-error" role="alert">{{ tr('内容块超过 256 KiB，无法保存。') }}</p>
    </article>

    <div class="content-block-add" role="group" :aria-label="tr('添加内容块')">
      <m3e-button v-for="kind in CONTENT_BLOCK_KINDS" :key="kind" variant="text" type="button" @click="emit('add', kind)"><m3e-icon slot="icon" name="add"></m3e-icon>{{ tr(contentBlockKindLabel(kind)) }}</m3e-button>
    </div>
  </fieldset>
</template>
