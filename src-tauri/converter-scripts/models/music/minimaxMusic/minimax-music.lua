-- MiniMax music generation.
--
-- API reference:
--   https://platform.minimax.io/docs/api-reference/music-generation
--
-- The words and, where the caller has them, the lyrics are the song; a score
-- played under a telling's lines rather than sung is asked for as an
-- instrumental, which is this service's own flag. The direction a score was
-- described with — the genre and the mood — travels inside the words rather
-- than beside them, because no field of this service carries one.
--
-- The answer names where the song was left rather than carrying it: the bytes
-- would be hex written into the body, which is no shape a script can hand
-- over, so a link is asked for and the host fetches the song from there.
--
-- A refusal may arrive as a success: the status of this platform rides inside
-- the answer's own base_resp, so a 200 is read for it before anything else.

local function trimmed(text)
  return (text:gsub("^%s+", ""):gsub("%s+$", ""))
end

local function text_param(params, key)
  local value = params[key]
  if type(value) == "string" and trimmed(value) ~= "" then
    return trimmed(value)
  end
  return nil
end

-- The containers this service writes. A name from the room's wider list is
-- left to the service's own choice rather than sent to be refused.
local FORMATS = {
  mp3 = "audio/mpeg",
  wav = "audio/wav",
}

function build_request(call, req, inputs)
  local body = {model = call.model}
  if req.prompt and trimmed(req.prompt) ~= "" then
    body.prompt = req.prompt
  end
  local lyrics = text_param(req.params, "lyrics")
  if lyrics ~= nil then
    body.lyrics = lyrics
  end
  if req.params.instrumental ~= nil then
    body.is_instrumental = req.params.instrumental
  end
  local format = text_param(req.params, "format")
  local chosen_format = nil
  if format ~= nil and FORMATS[format:lower()] ~= nil then
    chosen_format = format:lower()
    body.audio_setting = {format = chosen_format}
  end
  -- The answer names where the song was left rather than carrying it.
  body.output_format = "url"

  return {
    -- Handed to the answer so the song is stored under the type it was asked
    -- for, which the answer itself does not say.
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
  if type(data.status) == "number" and data.status ~= 2 then
    -- A composition that has not finished is no composition, and one waited
    -- for here would never arrive: this service reports progress to a stream,
    -- and a one-shot ask was told the song is done or nothing.
    return {error = "the service answered before the song was composed"}
  end
  if type(address) ~= "string" or trimmed(address) == "" then
    return {error = "the service answered without a song"}
  end
  if not string.match(trimmed(address), "^https?://") then
    return {error = "the answer carried the song itself rather than an address for it"}
  end
  local mime = FORMATS[((state or {}).format) or ""] or "audio/mpeg"
  local usage = nil
  local info = payload.extra_info
  if type(info) == "table" then
    local length_ms = tonumber(info.music_duration)
    if length_ms ~= nil then
      usage = {seconds = length_ms / 1000.0}
    end
  end
  return {items = {{url = trimmed(address), mime = mime}}, usage = usage}
end
