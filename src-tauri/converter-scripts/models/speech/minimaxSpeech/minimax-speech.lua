-- MiniMax speech: words and a voice, answered with a link to the recording.
--
-- API reference:
--   https://platform.minimax.io/docs/api-reference/speech-t2a-http
--
-- The service answers with the recording's bytes written as hex by default,
-- which is no shape a script can hand over; asked for a link instead, the
-- answer names where the recording was left and the host fetches it from
-- there — an address of the platform's own, so nothing follows it.
--
-- The voice, the pace, the pitch, and the loudness are this service's own
-- settings, gathered under `voice_setting` rather than set beside the words,
-- and its ranges are narrower than the room's own scales: a pace outside them
-- is brought to the nearest end rather than sent to be refused, the room's
-- loudness is read as the tenths this service counts in, and the room's pitch
-- is a multiplier of the voice's own frequency, which is the semitones this
-- service names once it is written as one.
--
-- A refusal may arrive as a success: the status of this platform rides inside
-- the answer's own base_resp, so a 200 is read for it before anything else.

local function trimmed(text)
  return (text:gsub("^%s+", ""):gsub("%s+$", ""))
end

local function number_param(params, key)
  local value = params[key]
  if type(value) == "number" then
    return value
  end
  if type(value) == "string" then
    return tonumber(trimmed(value))
  end
  return nil
end

local function text_param(params, key)
  local value = params[key]
  if type(value) == "string" and trimmed(value) ~= "" then
    return trimmed(value)
  end
  return nil
end

local function clamped(value, low, high)
  if value < low then
    return low
  end
  if value > high then
    return high
  end
  return value
end

-- The rates this service records at. A rate of its own list travels as it is
-- stated, and anything else is the service's own default rather than a number
-- it would refuse.
local RATES = {
  [8000] = true,
  [16000] = true,
  [22050] = true,
  [24000] = true,
  [32000] = true,
  [44100] = true,
}

-- The containers this service writes. The room's list is a part of this one;
-- a name this service does not know is left to its own choice rather than sent
-- to be refused.
local FORMATS = {
  mp3 = "audio/mpeg",
  wav = "audio/wav",
  flac = "audio/flac",
  opus = "audio/opus",
  pcm = "audio/l16",
}

-- The pitch a multiplier means, in the semitones this service names: an octave
-- up or down is twelve of them, and the service's own ends are where anything
-- wider is brought.
local function semitones(multiplier)
  if multiplier <= 0 then
    return 0
  end
  local steps = 12.0 * math.log(multiplier) / math.log(2.0)
  return clamped(math.floor(steps + 0.5), -12, 12)
end

function build_request(call, req, inputs)
  local body = {model = call.model, text = req.prompt or ""}
  local voice = {}
  local voice_id = text_param(req.params, "voice")
  if voice_id ~= nil then
    voice.voice_id = voice_id
  end
  local pace = number_param(req.params, "rate") or number_param(req.params, "speed")
  if pace ~= nil then
    voice.speed = clamped(pace, 0.5, 2.0)
  end
  local loudness = number_param(req.params, "volume")
  if loudness ~= nil then
    -- The room counts loudness in hundredths of full, and this service in
    -- tenths of it.
    voice.vol = clamped(loudness / 10.0, 0.1, 10.0)
  end
  local pitch = number_param(req.params, "pitch")
  if pitch ~= nil then
    voice.pitch = semitones(pitch)
  end
  if next(voice) ~= nil then
    body.voice_setting = voice
  end

  local audio = {}
  local chosen_format = nil
  local requested_format = text_param(req.params, "format")
  if requested_format ~= nil and FORMATS[requested_format:lower()] ~= nil then
    chosen_format = requested_format:lower()
    audio.format = chosen_format
  end
  local rate = number_param(req.params, "sampleRate")
  if rate ~= nil and RATES[math.floor(rate + 0.5)] ~= nil then
    audio.sample_rate = math.floor(rate + 0.5)
  end
  if next(audio) ~= nil then
    body.audio_setting = audio
  end

  -- The answer names where the recording was left rather than carrying it.
  body.output_format = "url"
  body.stream = false

  return {
    -- Handed to the answer so the recording is stored under the type it was
    -- asked for, which the answer itself does not say.
    state = {format = chosen_format},
    method = "POST",
    url = call.url,
    headers = {["Content-Type"] = "application/json"},
    body = json.encode(body),
  }
end

-- The complaint this platform carries inside an answer: its endpoints report
-- a refusal as a success whose own status says otherwise.
local function refusal(payload)
  local response = payload.base_resp
  if type(response) ~= "table" then
    return nil
  end
  local code = tonumber(response.status_code or 0) or 0
  if code == 0 then
    return nil
  end
  local said = trimmed(tostring(response.status_msg or ""))
  if said == "" then
    said = "the service refused the request (code " .. tostring(response.status_code) .. ")"
  end
  return said
end

function parse_response(status, headers, body, state)
  local payload = json.decode(body)
  local refused = refusal(payload)
  if refused ~= nil then
    return {error = refused}
  end
  local data = payload.data or {}
  local address = data.audio
  if type(address) ~= "string" or trimmed(address) == "" then
    return {error = "the service answered without a recording"}
  end
  if not string.match(trimmed(address), "^https?://") then
    -- The recording came back written out rather than named: a shape nothing
    -- above a script can carry, and one the ask was meant to prevent.
    return {error = "the answer carried the recording itself rather than an address for it"}
  end
  local mime = FORMATS[((state or {}).format) or ""] or "audio/mpeg"
  local usage = nil
  local info = payload.extra_info
  if type(info) == "table" then
    local length_ms = tonumber(info.audio_length)
    if length_ms ~= nil then
      usage = {seconds = length_ms / 1000.0}
    end
  end
  return {items = {{url = trimmed(address), mime = mime}}, usage = usage}
end
