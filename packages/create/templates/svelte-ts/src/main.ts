import { mount } from "svelte";

import App from "./App.svelte";
import "./style.css";

const target = document.getElementById("app");
if (!target) throw new Error("index.html is missing #app");

export default mount(App, { target });
