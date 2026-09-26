-- Alibaba Cloud Bailian (Model Studio) text generation.
--
-- Words alone are asked at the text-generation endpoint a configuration names.
-- A question carrying a picture is asked at the multimodal sibling beside it,
-- which is the same service reading a message as parts rather than as one
-- string — and an address that already names the multimodal service is left
-- where it is, since a model that only answers there is reachable without a
-- second setting.
--
-- The answer arrives in one document, or in a stream when the service was
-- asked for one. Streaming is asked for in a header here rather than in the
-- body, and each piece is asked for as a piece rather than as the whole answer
-- so far.
--
-- A refusal can arrive as a success, with the explanation in the body beside a
-- code rather than in a status, which reading as an empty answer would blame
-- on the model being quiet.

local MULTIMODAL = {service = "multimodal-generation", reading = "text-generation"}

local function trimmed(text)
  return (text:gsub("^%s+", ""):gsub("%s+$", ""))
end

local function ends_with(text, suffix)
  return text:sub(-#suffix) == suffix
end

-- The multimodal sibling of the address a configuration names.
local function multimodal_url(url)
  local trimmed_url = url:gsub("/+$", "")
  local suffix = "/" .. MULTIMODAL.reading .. "/generation"
  if ends_with(trimmed_url, suffix) then
    return trimmed_url:sub(1, #trimmed_url - #suffix) .. "/" .. MULTIMODAL.service .. "/generation"
  end
  return url
end

local function is_multimodal(url)
  return url:find("/" .. MULTIMODAL.service .. "/", 1, true) ~= nil
end

local function pictures_of(inputs)
  local pictures = {}
  for _, input in ipairs(inputs) do
    if (input.mime or ""):sub(1, 6) == "image/" then
      table.insert(pictures, input)
    end
  end
  return pictures
end

-- One message's content as the chosen service reads it: a bare string where it
-- reads one, and a document of parts where it reads that.
local function said(text, parts)
  if parts then
    return {{text = text}}
  end
  return text
end

-- The question itself: the words alone where that is all it is, and beside the
-- pictures otherwise.
local function asked(req, pictures, parts)
  if not parts then
    return req.prompt or ""
  end
  local content = {}
  if req.prompt and trimmed(req.prompt) ~= "" then
    table.insert(content, {text = req.prompt})
  end
  for _, picture in ipairs(pictures) do
    table.insert(content, {image = picture.data_url})
  end
  return content
end

local function integer_param(params, key)
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

-- What the service is told about the answer, under the names it uses.
local function parameters(req, streaming)
  -- A message is asked for rather than a bare string, which is also the shape
  -- an answer with a picture's parts in it arrives under.
  local told = {result_format = "message"}
  if streaming then
    -- Without this, every piece repeats the whole answer so far, and a reader
    -- of pieces collects it over and over.
    told.incremental_output = true
  end
  local temperature = number_param(req.params, "temperature")
  if temperature ~= nil then
    told.temperature = temperature
  end
  local tokens = integer_param(req.params, "maxTokens")
  if tokens ~= nil then
    told.max_tokens = tokens
  end
  return told
end

-- The address one question goes to, and whether that address reads a message
-- as parts rather than as one string.
local function address(call, pictures)
  if #pictures > 0 then
    return multimodal_url(call.url), true
  end
  if is_multimodal(call.url) then
    return call.url, true
  end
  return call.url, false
end

local function describe(call, req, inputs, streaming)
  local pictures = pictures_of(inputs)
  local url, parts = address(call, pictures)
  local messages = {}
  if req.system and trimmed(req.system) ~= "" then
    table.insert(messages, {role = "system", content = said(req.system, parts)})
  end
  table.insert(messages, {role = "user", content = asked(req, pictures, parts)})
  return {
    method = "POST",
    url = url,
    headers = {["Content-Type"] = "application/json"},
    body = json.encode({
      model = call.model,
      input = {messages = messages},
      parameters = parameters(req, streaming),
    }),
  }
end

-- The complaint in an answer that carried one instead of a generation: this
-- service names it in a `code` beside a `message`, where an answer would carry
-- an `output`.
local function refusal(payload)
  local code = payload.code
  if code == nil or payload.output ~= nil then
    return nil
  end
  local explanation = trimmed(tostring(payload.message or ""))
  if explanation == "" then
    return "the service refused the request: " .. tostring(code)
  end
  return tostring(code) .. ": " .. explanation
end

-- The text of the first choice, which this service spells either as one string
-- or as a document of parts.
local function choice_content(payload)
  local choice = payload.output and payload.output.choices and payload.output.choices[1]
  local content = choice and choice.message and choice.message.content
  local text = nil
  if type(content) == "string" then
    text = content
  elseif type(content) == "table" then
    local parts = {}
    for _, part in ipairs(content) do
      if type(part.text) == "string" then
        table.insert(parts, part.text)
      end
    end
    text = table.concat(parts)
  else
    -- `result_format: "text"` is the older default, where the answer is a bare
    -- string rather than a message.
    text = payload.output and payload.output.text
  end
  if text == nil or trimmed(text) == "" then
    return nil
  end
  return text
end

local function tokens(payload)
  local counted = payload.usage
  if type(counted) ~= "table" then
    return nil
  end
  local input = counted.input_tokens
  local output = counted.output_tokens
  if input == nil and output == nil then
    return nil
  end
  return {input_tokens = input, output_tokens = output}
end

function build_request(call, req, inputs)
  return describe(call, req, inputs, false)
end

-- A stream is asked for in a header here rather than in the body, which is
-- what the raw HTTP shape of the service reads.
function build_stream_request(call, req, inputs)
  local request = describe(call, req, inputs, true)
  request.headers["X-Dashscope-Sse"] = "enable"
  return request
end

function parse_response(status, headers, body)
  local payload = json.decode(body)
  local refused = refusal(payload)
  if refused ~= nil then
    return {error = refused}
  end
  return {text = choice_content(payload), usage = tokens(payload)}
end

-- One event in a stream, which carries the piece written since the last one
-- and, where the service reported them, the totals so far. A stream that has
-- opened has no status left to refuse with, so a failure arrives as an event
-- carrying the complaint instead of a piece.
function parse_event(event)
  local payload = json.decode(event)
  local refused = refusal(payload)
  if refused ~= nil then
    return {failed = refused}
  end
  return {text = choice_content(payload), usage = tokens(payload)}
end
