<script setup lang="ts">
/**
 * The popover.
 *
 * Deliberately small: everything here is also on the tray menu, because the
 * menu is what a user gets when they right-click and it has to stand on its
 * own. This is the nicer way in, not the only one.
 */
import { computed } from "vue";

import { command } from "./menubar.js";
import { clock, LENGTH, timer } from "./timer.js";
import { close } from "./popover.js";

const remaining = computed(() => clock(timer.left));

// A ring that empties as the phase runs down. `stroke-dasharray` on a circle
// is the whole trick - no animation library, and it follows the state exactly
// rather than trying to keep up with it.
const R = 52;
const CIRCUMFERENCE = 2 * Math.PI * R;
const progress = computed(() => {
  const total = LENGTH[timer.phase];
  return CIRCUMFERENCE * (1 - Math.max(0, Math.min(1, timer.left / total)));
});
</script>

<template>
  <main :class="['app', timer.phase]">
    <header>
      <span class="phase">{{ timer.phase === "focus" ? "Focus" : "Break" }}</span>
      <button class="icon" title="Close" @click="close()">
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      </button>
    </header>

    <div class="dial">
      <svg viewBox="0 0 120 120">
        <circle class="track" cx="60" cy="60" :r="R" />
        <circle
          class="run"
          cx="60"
          cy="60"
          :r="R"
          :stroke-dasharray="CIRCUMFERENCE"
          :stroke-dashoffset="progress"
        />
      </svg>
      <span class="time">{{ remaining }}</span>
    </div>

    <div class="controls">
      <button class="primary" @click="command('toggle')">
        {{ timer.running ? "Pause" : "Start" }}
      </button>
      <button @click="command('reset')" :disabled="timer.left >= LENGTH[timer.phase]">
        Reset
      </button>
    </div>

    <footer>
      <button
        :class="{ on: timer.phase === 'focus' }"
        @click="command('focus')"
      >
        25 min
      </button>
      <button
        :class="{ on: timer.phase === 'break' }"
        @click="command('break')"
      >
        5 min
      </button>
      <span class="count" :title="`${timer.done} completed`">{{ timer.done }} done</span>
    </footer>
  </main>
</template>
