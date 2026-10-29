--助教账号与空间管理员统一为管理员账号。
UPDATE "User"
SET "role" = 'ADMIN'
WHERE "role" = 'ASSISTANT';

-- 固定工位由角色限制学员访问，不应同时被当作停用座位。
UPDATE "Seat"
SET "enabled" = TRUE
WHERE "fixedForAssistant" = TRUE;
