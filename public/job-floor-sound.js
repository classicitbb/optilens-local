/* Local synthesized scanner cues: no media download or service request. */
(function (root) {
  "use strict";
  function createSound(options) {
    var AudioContext = options.AudioContext;
    var context = null;
    var nextTime = 0;
    var resuming = null;
    function publish() {
      var ready = Boolean(context && context.state === "running");
      options.onReady(ready, Boolean(AudioContext));
      return ready;
    }
    async function unlock() {
      try {
        if (!AudioContext) return publish();
        if (!context || context.state === "closed") {
          context = new AudioContext();
          nextTime = 0;
          context.onstatechange = publish;
        }
        if (context.state !== "running") {
          if (!resuming) {
            resuming = Promise.resolve(context.resume()).then(publish, function () {
              options.onReady(false, Boolean(AudioContext));
              return false;
            }).finally(function () { resuming = null; });
          }
          await resuming;
        }
        return publish();
      } catch (error) {
        options.onReady(false, Boolean(AudioContext));
        return false;
      }
    }
    function play(success) {
      if (!publish()) {
        // Local validation may finish in the same key event that unlocks sound.
        // Wait only for that gesture's existing resume, never replay old alerts.
        if (resuming) resuming.then(function (ready) { if (ready) play(success); });
        return false;
      }
      try {
        var start = Math.max(context.currentTime + .015, nextTime);
        var frequencies = success ? [988, 1319] : [220, 165, 110];
        var duration = success ? .16 : .19;
        var gap = .08;
        frequencies.forEach(function (frequency, index) {
          var at = start + index * (duration + gap);
          var oscillator = context.createOscillator();
          var gain = context.createGain();
          oscillator.type = success ? "square" : "sawtooth";
          oscillator.frequency.setValueAtTime(frequency, at);
          gain.gain.setValueAtTime(0, at);
          gain.gain.linearRampToValueAtTime(.8, at + .008);
          gain.gain.setValueAtTime(.8, at + duration - .015);
          gain.gain.linearRampToValueAtTime(0, at + duration);
          oscillator.connect(gain);
          gain.connect(context.destination);
          oscillator.onended = function () { oscillator.disconnect(); gain.disconnect(); };
          oscillator.start(at);
          oscillator.stop(at + duration);
        });
        nextTime = start + frequencies.length * (duration + gap);
        return true;
      } catch (error) {
        options.onReady(false, Boolean(AudioContext));
        return false;
      }
    }
    return { unlock: unlock, play: play };
  }
  if (typeof module === "object" && module.exports) module.exports = { createSound: createSound };
  else root.JobFloorSound = { createSound: createSound };
})(typeof window === "object" ? window : this);
