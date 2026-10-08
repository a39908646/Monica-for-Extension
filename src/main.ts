import { createApp } from "vue";
import App from "./App.vue";
import "./tokens.css";
import "./styles.css";
// manager.css 按职责拆成以下文件；它们共享同一条级联，导入顺序不可调整。
import "./manager-shell.css";
import "./manager-dialog.css";
import "./manager-editor.css";
import "./manager-provider.css";
import "./manager-provider-status.css";
import "./manager-editor-controls.css";
import "./manager-responsive.css";
import "./manager-generator.css";
import "./manager-steam.css";
import "./nothing.css";
import "./responsive.css";
import "./detail-layout.css";
import "./home.css";
import "./lib/action-button-layout";
import { initializeI18n } from "./i18n";

void initializeI18n().then(() => createApp(App).mount("#root"));
