import { createApp } from "vue";

import App from "./App.vue";
import "./style.css";

const target = document.getElementById("app");
if (!target) throw new Error("index.html is missing #app");

createApp(App).mount(target);
