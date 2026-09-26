-- OpenAI-compatible speech: a request of words and settings, answered with the
-- recording itself.
--
-- The answer is bytes rather than a document, so what it is comes from the
-- answer's own type; the host sniffs the bytes and stores them under the type
-- they turn out to be, because a container's name is not always one a file can
-- be kept as.

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

function build_request(call, req, inputs)
  local body = {model = call.model, input = req.prompt or ""}
  if type(req.params.voice) == "string" and trimmed(req.params.voice) ~= "" then
    body.voice = req.params.voice
  end
  if type(req.params.format) == "string" and trimmed(req.params.format) ~= "" then
    body.response_format = req.params.format
  end
  local speed = number_param(req.params, "speed")
  if speed ~= nil then
    body.speed = speed
  end
  if req.system and trimmed(req.system) ~= "" then
    body.instructions = req.system
  end

  return {
    method = "POST",
    url = call.url,
    headers = {["Content-Type"] = "application/json"},
    body = json.encode(body),
  }
end

function parse_response(status, headers, body)
  -- The recording is the answer's own bytes, which the host takes as they
  -- stand; the type it was announced with is a claim the bytes are checked
  -- against rather than trusted over.
  local announced = headers["content-type"]
  local claimed = nil
  if type(announced) == "string" then
    -- Whatever follows the type — a charset, for instance — is not part of it.
    claimed = trimmed(announced:match("^[^;]+") or announced)
    if claimed == "" then
      claimed = nil
    end
  end
  return {items = {{raw = true, mime = claimed}}}
end
