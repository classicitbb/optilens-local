# RX Capture voice and typed input

Voice is a third way in, next to Photo and Manual. A capture uses exactly one
of them. After extraction the order follows the normal review, validation and
Submit to Innovations flow.

## Flow

1. Pick the customer. The customer box lists the employee's frequent customers
   (last 90 days, frequency with a recency boost, topped up with the team's)
   before anything is typed. Voice never selects a customer.
2. Choose **Voice / type** and tap **Record** (or Alt+V). Each clip can be up to
   3 minutes; several clips can be added.
3. Each clip is transcribed (`POST /api/rx-capture/transcribe`) and split by a
   keyword splitter (`public/rx-capture-voice.js`) into labelled boxes: Right,
   Left, Both, Add/PD/heights, Prism, Lens, Frame, Patient, Instructions,
   Unassigned. Text can also be typed or pasted straight into the boxes.
4. The employee checks and corrects the words, then **Submit for extraction**.
   The checked text is extracted like a photo, then the usual review form opens.

## Safety rules

The extractor returns values plus the exact words behind each one.
`lib/rx-capture/voice-rules.js` then makes a field uncertain when:

- a sphere or cylinder power was spoken without plus or minus (plano is fine;
  ADD is always positive and is not checked);
- no quoted words support the value, or the quote is not in the transcript;
- two different values were spoken for the same field.

Segment labels are hints only: the eye comes from the words. A customer named
in the dictation that differs from the selected one adds a non-blocking note.
Uncertain fields show their reason and the quoted words in the review form.

## Data

- Audio is held in the browser until transcribed and in server memory during
  transcription; it is not written to disk unless `RX_CAPTURE_RETAIN_AUDIO=true`.
- The raw transcript and the checked segments are stored with the order
  (`transcript_raw_json`, `transcript_edited_json`, migration 049).
  **Try again** re-extracts from the stored segments.
- `input_mode` records `photo`, `manual`, `voice` (at least one clip) or `text`
  (typed only). Event payloads carry counts and the mode, never transcript text.

## Configuration

- `OPENAI_RX_TRANSCRIBE_MODEL` (default `gpt-4o-transcribe`). Pin a dated
  snapshot and change it only after `node scripts/rx-voice-regression.js`
  passes against the recordings in `test/fixtures/rx-voice-audio/`.
- The trigger phrases live in `TRIGGERS` in `public/rx-capture-voice.js`.
- The microphone needs a secure page (the LAN HTTPS site on a device that
  trusts the local CA). Without it the Record button is disabled with the
  reason, and typing still works.
