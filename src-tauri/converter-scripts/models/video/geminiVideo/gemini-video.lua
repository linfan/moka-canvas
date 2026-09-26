-- Google Gemini · long-running (Veo) (video generation, async job)
--
-- A shot does not answer in one call: the job is started here, and what it left
-- behind is collected later by looking for it. The handle the provider issues is
-- a path under the root of the configured address, so polling one needs that
-- root rather than the endpoint the job was started at.

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

-- Where a frame belongs in the shot: the ports label the ends, and anything
-- unlabelled keeps its place in between.
local function frame_rank(role)
  if role == "firstFrame" then
    return 0
  end
  if role == "lastFrame" then
    return 2
  end
  return 1
end

-- The image inputs, opening frame first. Sorted by what the sort was told
-- rather than by a bare comparison, so two unlabelled frames keep the order
-- they arrived in.
local function frames_of(inputs)
  local ranked = {}
  for index, input in ipairs(inputs or {}) do
    local mime = input.mime or ""
    if mime:sub(1, 6) == "image/" then
      table.insert(ranked, {rank = frame_rank(input.role), index = index, input = input})
    end
  end
  table.sort(ranked, function(left, right)
    if left.rank ~= right.rank then
      return left.rank < right.rank
    end
    return left.index < right.index
  end)
  local frames = {}
  for _, entry in ipairs(ranked) do
    table.insert(frames, entry.input)
  end
  return frames
end

-- What a request does with its images. The caller's preference is read first;
-- the count has the final say, because no provider takes three frames and a
-- request with more images than that becomes a reference request instead.
local function layout_of(frames, mode)
  local asked = "auto"
  if type(mode) == "string" then
    asked = mode
  end
  if asked == "reference" then
    if #frames == 0 then
      return "prompt"
    end
    return "reference"
  end
  if #frames == 0 then
    return "prompt"
  end
  if #frames == 1 then
    return "opening"
  end
  if #frames == 2 then
    return "both"
  end
  return "reference"
end

-- A frame as a job names it, which is a field of its own rather than a part of
-- a prompt.
local function named(frame)
  return {mimeType = frame.mime, bytesBase64Encoded = encoded(frame)}
end

function build_task_request(call, req, inputs)
  local frames = frames_of(inputs)
  local shot = {prompt = req.prompt}
  local layout = layout_of(frames, req.params.mode)
  if layout == "opening" or layout == "both" then
    shot.image = named(frames[1])
    if frames[2] ~= nil then
      shot.lastFrame = named(frames[2])
    end
  elseif layout == "reference" then
    local references = {}
    for _, frame in ipairs(frames) do
      table.insert(references, {referenceType = "ASSET", image = named(frame)})
    end
    shot.referenceImages = references
  end

  local parameters = {}
  if type(req.params.ratio) == "string" then
    parameters.aspectRatio = req.params.ratio
  end
  if type(req.params.resolution) == "string" then
    parameters.resolution = req.params.resolution
  end
  local seconds = whole_param(req.params, "seconds")
  if seconds ~= nil then
    parameters.durationSeconds = seconds
  end
  if type(req.params.generateAudio) == "boolean" then
    parameters.generateAudio = req.params.generateAudio
  end
  -- A watermark has no counterpart here, and inventing one would ask a
  -- provider for something it never offered.

  return {
    method = "POST",
    url = call.url,
    headers = {["Content-Type"] = "application/json"},
    body = json.encode({instances = {shot}, parameters = parameters}),
  }
end

function parse_task_response(status, headers, body)
  local payload = json.decode(body)
  -- Without a handle the job cannot be collected, which makes a 200 that lacks
  -- one a failure rather than an answer.
  local reference = payload.name
  if type(reference) ~= "string" or trimmed(reference) == "" then
    return {error = "the job started without a handle to poll"}
  end
  -- The provider does not say how often to look, and asking more often than
  -- this only adds refusals.
  return {reference = trimmed(reference), poll_interval_ms = 5000}
end

-- The root a job handle is relative to: everything before the `/models/`
-- segment of the configured address.
local function root_of(url)
  local cut = nil
  local at = 1
  while true do
    local found = url:find("/models/", at, true)
    if found == nil then
      break
    end
    cut = found
    at = found + 1
  end
  if cut ~= nil then
    return url:sub(1, cut - 1)
  end
  -- With no `/models/` to cut at, the handle is read against the host the
  -- configuration was reached on.
  return url:match("^(%a+://[^/]+)") or ""
end

function build_poll_request(call, task)
  return {
    method = "GET",
    url = root_of(call.url) .. "/" .. task.reference,
    headers = {},
  }
end

function parse_poll_response(status, headers, body)
  local payload = json.decode(body)
  if payload.done ~= true then
    return {status = "pending"}
  end
  -- A job that finished badly explains itself in the same document that says
  -- it finished.
  local explained = payload.error
  if type(explained) == "table" and type(explained.message) == "string" then
    local message = trimmed(explained.message)
    if message ~= "" then
      return {status = "failed", error = message}
    end
  end

  local items = {}
  local response = payload.response
  local generated = type(response) == "table" and response.generateVideoResponse or nil
  local samples = type(generated) == "table" and generated.generatedSamples or nil
  if type(samples) == "table" then
    for _, sample in ipairs(samples) do
      local video = sample.video
      local uri = type(video) == "table" and video.uri or nil
      -- A sample with nothing to collect is passed over rather than collected
      -- from nowhere.
      if type(uri) == "string" then
        table.insert(items, {url = uri, mime = "video/mp4"})
      end
    end
  end
  return {status = "succeeded", result = {items = items}}
end
