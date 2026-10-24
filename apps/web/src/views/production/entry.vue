<template>
  <RedrawFlow v-if="isRedraw" />
  <ProductionCanvas v-else />
</template>

<script setup lang="ts">
import projectStore from "@/stores/project";
import ProductionCanvas from "./index.vue";
import RedrawFlow from "@/views/redraw/flow/index.vue";

const { project } = storeToRefs(projectStore());
const isRedraw = computed(() => project.value?.projectType === "redraw");
</script>