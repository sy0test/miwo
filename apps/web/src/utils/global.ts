import { MessagePlugin } from "tdesign-vue-next";

import i18n from "@/locales";
const t: (key: string, ...args: any[]) => string = i18n.global.t;

declare global {
  interface Window {
    $message: typeof MessagePlugin;
    $port: string;
    $t: typeof t;
  }
}

window.$message = MessagePlugin;


window.$t = t;
