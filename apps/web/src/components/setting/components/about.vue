<template>
  <div class="about">
    <section class="product">
      <img src="@/assets/logo.png" alt="谜沃" class="logo" />
      <div>
        <h2>谜沃</h2>
        <p>{{ $t("settings.about.slogan") }}</p>
        <t-tag theme="primary" size="small">版本 v{{ version }}</t-tag>
      </div>
    </section>

    <section>
      <h3>代码仓库</h3>
      <t-card bordered>
        <a href="https://github.com/HBAI-Ltd/Toonflow-app" target="_blank" rel="noopener noreferrer">GitHub：github.com/HBAI-Ltd/Toonflow-app</a>
        <t-divider />
        <a href="https://gitee.com/HBAI-Ltd/Toonflow-app" target="_blank" rel="noopener noreferrer">Gitee：gitee.com/HBAI-Ltd/Toonflow-app</a>
      </t-card>
    </section>

    <section>
      <h3>许可证</h3>
      <t-card bordered>
        <a href="https://github.com/HBAI-Ltd/Toonflow-app?tab=Apache-2.0-1-ov-file" target="_blank" rel="noopener noreferrer">
          Apache-2.0 License · {{ $t("settings.about.licenseDesc") }}
        </a>
      </t-card>
    </section>
  </div>
</template>

<script setup lang="ts">
import axios from "@/utils/axios";
import store from "@/stores/index";

const { version } = storeToRefs(store());

onMounted(async () => {
  try {
    const { data } = await axios.get("/other/getVersion");
    version.value = data;
  } catch {
    // 保留应用启动时已有版本值，关于页不承担更新检查职责。
  }
});
</script>

<style lang="scss" scoped>
.about {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 8px;

  section > h3 {
    margin: 0 0 8px;
    font-size: 15px;
  }

  .product {
    display: flex;
    align-items: center;
    gap: 16px;

    .logo {
      width: 64px;
      height: 64px;
      object-fit: contain;
    }

    h2,
    p {
      margin: 0 0 8px;
    }
  }

  a {
    color: var(--td-text-color-primary);
    text-decoration: none;
  }

  a:hover {
    color: var(--td-brand-color);
  }
}
</style>
