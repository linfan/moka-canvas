-- Google Gemini · generateContent (text, image, audio)
--
-- Words, pictures and speech answer at one address here, because a request is a
-- document of parts and so is an answer: the three capabilities differ only in
-- what the answer is asked to contain. The model is named in the address rather
-- than in a body, so nothing here names it a second time.
--
-- This protocol has no upload to point at and no field of its own for a mask,
-- so every reference travels inside the request as a part beside the prompt. A
-- stream is asked for in the query, and each event is a whole answer document
-- carrying what has been written since the last one.

local function trimmed(text)
  return (text:gsub("^%s+", ""):gsub("%s+$", ""))
end

-- The base64 inside an input's data URL, which is where the bytes a script was
-- handed live: a script cannot carry bytes of its own.
local function encoded(input)
  local url = input.data_url or ""
  local comma = url:find(",", 1, true)
  if not comma then
    return ""
  end
  return url:sub(comma + 1)
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

local function whole_param(params, key)
  local value = params[key]
  if value == nil then
    return nil
  end
  if math.type(value) == "integer" then
    return value
  end
  if type(value) == "string" then
    local parsed = tonumber(trimmed(value))
    if parsed ~= nil and math.type(parsed) == "integer" then
      return parsed
    end
  end
  return nil
end

local function divisor(a, b)
  while b ~= 0 do
    a, b = b, a % b
  end
  return a
end

-- Two whole numbers out of the sides of a size, in whatever spacing it arrived.
-- A side of nothing, of zero, or of a fraction describes no shape at all.
local function sides(width, height)
  local left = tonumber(trimmed(width))
  local right = tonumber(trimmed(height))
  if left == nil or right == nil then
    return nil
  end
  if math.type(left) ~= "integer" or math.type(right) ~= "integer" then
    return nil
  end
  if left <= 0 or right <= 0 then
    return nil
  end
  return left, right
end

-- The shape a size describes, as this protocol states one.
--
-- A size in pixels is reduced so that a provider comparing it against the
-- handful of shapes it offers can recognise it. A shape already stated as one
-- is the answer: reducing it again would turn a shape a provider lists into one
-- it does not.
local function aspect_ratio(size)
  if type(size) ~= "string" then
    return nil
  end
  local stated = trimmed(size):lower()
  local width, height = stated:match("^([^:]+):(.+)$")
  if width ~= nil then
    local left, right = sides(width, height)
    if left == nil then
      return nil
    end
    return left .. ":" .. right
  end
  width, height = stated:match("^([^x]+)x(.+)$")
  if width == nil then
    return nil
  end
  local left, right = sides(width, height)
  if left == nil then
    return nil
  end
  local shared = divisor(left, right)
  return (left // shared) .. ":" .. (right // shared)
end

-- What to ask an answer for. Nothing at all when the prompt says everything,
-- since an empty field would claim otherwise.
local function generation_config(req)
  local config = {}
  -- A model that can answer in pictures or in speech has to be asked for them:
  -- words alone are the default, and a picture nobody asked for is a picture
  -- that never arrives.
  if req.capability == "image" then
    config.responseModalities = {"TEXT", "IMAGE"}
  elseif req.capability == "audio" then
    config.responseModalities = {"AUDIO"}
  end
  local temperature = number_param(req.params, "temperature")
  if temperature ~= nil then
    config.temperature = temperature
  end
  local tokens = whole_param(req.params, "maxTokens")
  if tokens ~= nil then
    config.maxOutputTokens = tokens
  end
  local count = whole_param(req.params, "count")
  if count ~= nil and count > 1 then
    config.candidateCount = count
  end
  -- The size somebody picked describes a shape, which is what this protocol can
  -- be told about, so it travels as one rather than being dropped.
  local ratio = aspect_ratio(req.params.size)
  if ratio ~= nil then
    config.imageConfig = {aspectRatio = ratio}
  end
  local voice = req.params.voice
  if type(voice) == "string" then
    config.speechConfig = {voiceConfig = {prebuiltVoiceConfig = {voiceName = voice}}}
  end
  if next(config) == nil then
    return nil
  end
  return config
end

local function question(req, inputs)
  local parts = {}
  if type(req.prompt) == "string" and trimmed(req.prompt) ~= "" then
    table.insert(parts, {text = req.prompt})
  end
  -- Every reference travels inside the request, a mask among them: this
  -- protocol has no field of its own for one, and dropping it would answer a
  -- question that was not asked.
  for _, input in ipairs(inputs or {}) do
    table.insert(parts, {inlineData = {mimeType = input.mime, data = encoded(input)}})
  end

  local body = {contents = {{role = "user", parts = parts}}}
  if type(req.system) == "string" and trimmed(req.system) ~= "" then
    body.systemInstruction = {parts = {{text = req.system}}}
  end
  local config = generation_config(req)
  if config ~= nil then
    body.generationConfig = config
  end
  return body
end

-- The streaming form of a content address. A configuration that names some
-- other action is streamed at the address it names, and the provider gets to
-- refuse it.
local function stream_url(url)
  local prefix = url:match("^(.*):generateContent$")
  if prefix == nil then
    return url
  end
  return prefix .. ":streamGenerateContent"
end

local function asked_at(url, pair)
  if url:find("?", 1, true) ~= nil then
    return url .. "&" .. pair
  end
  return url .. "?" .. pair
end

local function described(call, req, inputs, url)
  return {
    method = "POST",
    url = url,
    headers = {["Content-Type"] = "application/json"},
    body = json.encode(question(req, inputs)),
    -- What the answer is read as when nothing in it names a type: speech
    -- arrives in a wave container here, and only an audio request answers with
    -- speech at all.
    state = {capability = req.capability},
  }
end

function build_request(call, req, inputs)
  return described(call, req, inputs, call.url)
end

-- Only the words stream. A caller reading the pieces of a picture would be
-- waiting on a stream this protocol never sends.
function build_stream_request(call, req, inputs)
  if req.capability ~= "text" then
    return {error = req.capability .. " generation does not stream"}
  end
  return described(call, req, inputs, asked_at(stream_url(call.url), "alt=sse"))
end

local function tokens(payload)
  local counted = payload.usageMetadata
  if type(counted) ~= "table" then
    return nil
  end
  local input = counted.promptTokenCount
  local output = counted.candidatesTokenCount
  if input == nil and output == nil then
    return nil
  end
  return {input_tokens = input, output_tokens = output}
end

local function candidates(payload)
  local list = payload.candidates
  if type(list) ~= "table" then
    return {}
  end
  return list
end

local function parts_of(candidate)
  local content = candidate.content
  if type(content) ~= "table" or type(content.parts) ~= "table" then
    return {}
  end
  return content.parts
end

-- The mime an answer is read as when neither its bytes nor the provider named
-- one. Only media can need it: an image is read from its own bytes.
local function fallback_mime(capability)
  if capability == "audio" then
    return "audio/wav"
  end
  return "video/mp4"
end

function parse_response(status, headers, body, state)
  local payload = json.decode(body)
  -- A refusal can arrive as a success: a prompt this provider would not answer
  -- is explained in a field of its own rather than in a status.
  local feedback = payload.promptFeedback
  if type(feedback) == "table" and feedback.blockReason ~= nil then
    return {error = "the prompt was refused: " .. tostring(feedback.blockReason)}
  end

  local text = ""
  local items = {}
  for _, candidate in ipairs(candidates(payload)) do
    for _, part in ipairs(parts_of(candidate)) do
      local inline = part.inlineData
      if type(inline) == "table" then
        table.insert(items, {
          base64 = inline.data or "",
          mime = inline.mimeType or fallback_mime(state and state.capability),
        })
      elseif type(part.text) == "string" then
        text = text .. part.text
      end
    end
  end
  if trimmed(text) == "" then
    text = nil
  end
  return {text = text, items = items, usage = tokens(payload)}
end

-- One event: the piece written since the last one, and the totals where the
-- service reported them at the end.
function parse_event(event)
  local payload = json.decode(event)
  local text = ""
  for _, candidate in ipairs(candidates(payload)) do
    for _, part in ipairs(parts_of(candidate)) do
      if type(part.text) == "string" then
        text = text .. part.text
      end
    end
  end
  if text == "" then
    text = nil
  end
  return {text = text, complete = nil, usage = tokens(payload)}
end
