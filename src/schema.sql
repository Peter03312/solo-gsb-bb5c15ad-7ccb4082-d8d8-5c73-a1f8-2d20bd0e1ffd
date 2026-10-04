-- 纸质展品光照额度管理：数据库结构
-- 剂量单位统一为 lx·h（照度小时积），按墙上时间（配置的固定 UTC 偏移）归属自然年。

CREATE TABLE IF NOT EXISTS users (
    id              BIGSERIAL PRIMARY KEY,
    username        TEXT NOT NULL UNIQUE,
    password_hash   TEXT NOT NULL,
    role            TEXT NOT NULL CHECK (role IN ('conservator', 'installer')),
    display_name    TEXT NOT NULL,
    active          BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS exhibits (
    id              BIGSERIAL PRIMARY KEY,
    name            TEXT NOT NULL,
    accession_no    TEXT,
    medium          TEXT,
    note            TEXT,
    created_by      BIGINT REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 每件展品每个自然年的年度照度时数上限（lx·h）
CREATE TABLE IF NOT EXISTS annual_limits (
    id              BIGSERIAL PRIMARY KEY,
    exhibit_id      BIGINT NOT NULL REFERENCES exhibits(id) ON DELETE CASCADE,
    year            INTEGER NOT NULL CHECK (year BETWEEN 1900 AND 2999),
    limit_lxh       NUMERIC(12,3) NOT NULL CHECK (limit_lxh > 0),
    created_by      BIGINT REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (exhibit_id, year)
);

-- 布展计划
-- status: submitted 待批准 / approved 已批准 / rejected 已驳回 / cancelled 已取消 /
--         pending_review 待复核（迟到实测超额导致）
CREATE TABLE IF NOT EXISTS plans (
    id              BIGSERIAL PRIMARY KEY,
    exhibit_id      BIGINT NOT NULL REFERENCES exhibits(id) ON DELETE CASCADE,
    title           TEXT NOT NULL,
    start_date      DATE NOT NULL,
    end_date        DATE NOT NULL CHECK (end_date >= start_date),
    -- 每日开灯时段，形如 ["09:00-12:00","13:00-17:00"]
    light_periods   JSONB NOT NULL,
    estimated_lux   NUMERIC(10,2) NOT NULL CHECK (estimated_lux > 0),
    status          TEXT NOT NULL DEFAULT 'submitted'
                    CHECK (status IN ('submitted','approved','rejected','cancelled','pending_review')),
    review_reason   TEXT,
    created_by      BIGINT REFERENCES users(id),
    approved_by     BIGINT REFERENCES users(id),
    approved_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_plans_exhibit_status ON plans (exhibit_id, status);

-- 计划调整申请（布展员对“已批准且尚未开始”的计划提交，保管员审核）
-- status: pending 待审 / approved 已通过 / rejected 已驳回 / withdrawn 已撤回
-- 同一计划同时只允许一份 pending 申请（部分唯一索引保证）。
-- 待审期间原计划继续占用额度；通过后原子更新 plans 的展期/开灯时段/预计照度。
CREATE TABLE IF NOT EXISTS plan_adjustments (
    id                    BIGSERIAL PRIMARY KEY,
    plan_id               BIGINT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    exhibit_id            BIGINT NOT NULL REFERENCES exhibits(id) ON DELETE CASCADE,
    start_date            DATE NOT NULL,
    end_date              DATE NOT NULL CHECK (end_date >= start_date),
    light_periods         JSONB NOT NULL,
    estimated_lux         NUMERIC(10,2) NOT NULL CHECK (estimated_lux > 0),
    reason                TEXT,
    status                TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','approved','rejected','withdrawn')),
    reject_reason         TEXT,
    created_by            BIGINT REFERENCES users(id),
    reviewed_by           BIGINT REFERENCES users(id),
    reviewed_at           TIMESTAMPTZ,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 同一计划同时只允许一份待审申请；已结案（通过/驳回/撤回）的记录保留。
CREATE UNIQUE INDEX IF NOT EXISTS uq_adjustment_pending_per_plan
    ON plan_adjustments (plan_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_adjustment_exhibit ON plan_adjustments (exhibit_id, status);
CREATE INDEX IF NOT EXISTS idx_adjustment_plan ON plan_adjustments (plan_id, id);

-- 实测记录：先录入（draft），保管员确认（confirmed）后以实测替代估算；
-- annulled 表示登记作废（原始记录保留）。
-- 实测纠错：保管员对已确认实测发起纠错时，原记录置 annulled（保留、不删改剂量字段），
-- 另插入一条 confirmed 的替代记录；两者经 replaces_measurement_id / replaced_by_id 双向关联，
-- correction_reason 必填，记录纠错原因（原记录与替代记录都写同一份原因，供追溯）。
CREATE TABLE IF NOT EXISTS measurements (
    id              BIGSERIAL PRIMARY KEY,
    plan_id         BIGINT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    exhibit_id      BIGINT NOT NULL REFERENCES exhibits(id) ON DELETE CASCADE,
    start_ts        TIMESTAMPTZ NOT NULL,
    end_ts          TIMESTAMPTZ NOT NULL CHECK (end_ts > start_ts),
    actual_lux      NUMERIC(10,2) NOT NULL CHECK (actual_lux > 0),
    note            TEXT,
    status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','confirmed','annulled')),
    created_by      BIGINT REFERENCES users(id),
    confirmed_by    BIGINT REFERENCES users(id),
    confirmed_at    TIMESTAMPTZ,
    annulled_by     BIGINT REFERENCES users(id),
    annulled_at     TIMESTAMPTZ,
    replaces_measurement_id BIGINT REFERENCES measurements(id),
    replaced_by_id          BIGINT REFERENCES measurements(id),
    correction_reason       TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_meas_exhibit_status ON measurements (exhibit_id, status);
CREATE INDEX IF NOT EXISTS idx_meas_plan ON measurements (plan_id);
CREATE INDEX IF NOT EXISTS idx_meas_replaces ON measurements (replaces_measurement_id);

-- 既有库升级：补齐实测纠错关联列（首次建库时上述 CREATE TABLE 已包含，IF NOT EXISTS 为空操作）。
ALTER TABLE measurements ADD COLUMN IF NOT EXISTS replaces_measurement_id BIGINT;
ALTER TABLE measurements ADD COLUMN IF NOT EXISTS replaced_by_id BIGINT;
ALTER TABLE measurements ADD COLUMN IF NOT EXISTS correction_reason TEXT;

-- 停灯记录：保管员对已批准/待复核计划登记“已发生”的停灯时段（必填原因）。
-- 停灯时段只从所属计划“未被已确认实测覆盖”的估算时段中扣减剂量（按墙上自然年拆分），
-- 不减已确认实测、不释放原计划的排期占用（计划开灯窗与重叠判定均不变）。
-- 记录一经写入永久保留：不提供修改/删除接口；计划取消/调整后记录仍保留。
-- 不变量（由登记/实测/调整核对共同保证）：
--   * 起止为正时长、起点早于终点、结束不晚于登记当时；
--   * 完整落在登记时所属计划的开灯窗内（计划调整核对要求停灯仍落在新窗内）；
--   * 不与同展品任何未作废实测（含草稿）相交；
--   * 不与同展品其他停灯记录相交。
CREATE TABLE IF NOT EXISTS blackouts (
    id              BIGSERIAL PRIMARY KEY,
    plan_id         BIGINT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    exhibit_id      BIGINT NOT NULL REFERENCES exhibits(id) ON DELETE CASCADE,
    start_ts        TIMESTAMPTZ NOT NULL,
    end_ts          TIMESTAMPTZ NOT NULL CHECK (end_ts > start_ts),
    reason          TEXT NOT NULL,
    created_by      BIGINT REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_blackout_exhibit ON blackouts (exhibit_id, id);
CREATE INDEX IF NOT EXISTS idx_blackout_plan ON blackouts (plan_id, id);

-- 计划外照明事故（规则 17）：保管员登记“已发生”的计划外照明（实际用光，非估算）。
-- 事故按墙上自然年拆分后始终计入实际用光；与已批准/待复核计划开灯窗相交的部分按实际照度
-- 替代相应计划估算（计划残余中扣除该部分），窗外部分单独计量；不释放任何计划排期。
-- 不变量（由登记/实测/停灯/纠错等核对共同保证）：
--   * 起止为正时长、起点早于终点、结束不晚于登记当时、实际照度为正、原因必填；
--   * 不与同展品任何未作废实测（含草稿）相交；
--   * 不与同展品任何停灯记录相交；
--   * 不与同展品其他照明事故相交。
-- 事故一经写入永久保留：不提供修改/删除接口（计划取消/调整后记录仍保留，实际用光仍计入）。
CREATE TABLE IF NOT EXISTS lighting_incidents (
    id              BIGSERIAL PRIMARY KEY,
    exhibit_id      BIGINT NOT NULL REFERENCES exhibits(id) ON DELETE CASCADE,
    start_ts        TIMESTAMPTZ NOT NULL,
    end_ts          TIMESTAMPTZ NOT NULL CHECK (end_ts > start_ts),
    actual_lux      NUMERIC(10,2) NOT NULL CHECK (actual_lux > 0),
    reason          TEXT NOT NULL,
    created_by      BIGINT REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_incident_exhibit ON lighting_incidents (exhibit_id, id);

-- 实测 CSV 导入批次（规则 18）：保管员把某条已批准计划的分段实测 CSV 导入为待确认批次。
-- 每行含墙上起止日期时间与实际照度；导入时逐行校验（正时长、正照度、完整落在计划开灯窗内、
-- 行间及与同展品未作废实测/停灯/照明事故不相交），任一错误整批不保存。
-- 待确认批次不占额度、不参与任何重叠判定；确认时在展品锁事务内按实时占用重新校验，
-- 全部有效才原子生成已确认实测（measurements.import_batch_id 关联）并记录批次审计；
-- 校验失败批次保持待确认且不计量；重复确认幂等返回 confirm_result 中的原批次结果。
CREATE TABLE IF NOT EXISTS measurement_import_batches (
    id              BIGSERIAL PRIMARY KEY,
    plan_id         BIGINT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    exhibit_id      BIGINT NOT NULL REFERENCES exhibits(id) ON DELETE CASCADE,
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed')),
    source_name     TEXT,
    row_count       INTEGER NOT NULL,
    rows_json       JSONB NOT NULL,
    total_yearly    JSONB NOT NULL,
    measurement_ids JSONB,
    confirm_result  JSONB,
    created_by      BIGINT REFERENCES users(id),
    confirmed_by    BIGINT REFERENCES users(id),
    confirmed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mib_exhibit ON measurement_import_batches (exhibit_id, id);
CREATE INDEX IF NOT EXISTS idx_mib_plan ON measurement_import_batches (plan_id, id);

-- 批次确认生成的实测记录关联回导入批次（既有单条实测该列为 NULL，既有字段与口径不变）。
ALTER TABLE measurements ADD COLUMN IF NOT EXISTS import_batch_id BIGINT
    REFERENCES measurement_import_batches(id);

-- 展厅（以展厅标识 hall_code 识别；首次为某展厅登记驻留时自动创建）。
CREATE TABLE IF NOT EXISTS halls (
    id              BIGSERIAL PRIMARY KEY,
    hall_code       TEXT NOT NULL UNIQUE,
    name            TEXT,
    created_by      BIGINT REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 展品展厅驻留（陈列关系）：保管员以“展厅标识 + 展品编号 + 驻留起止”登记。
-- 不变量：单件展品的驻留区间不得重叠（不同展品同期驻留同一展厅允许）。
-- 已被共享照明归属覆盖的驻留不得回改（修改/删除由接口层查 shared_lighting_allocations 拒绝）。
CREATE TABLE IF NOT EXISTS exhibit_residences (
    id              BIGSERIAL PRIMARY KEY,
    exhibit_id      BIGINT NOT NULL REFERENCES exhibits(id) ON DELETE CASCADE,
    hall_id         BIGINT NOT NULL REFERENCES halls(id),
    start_ts        TIMESTAMPTZ NOT NULL,
    end_ts          TIMESTAMPTZ NOT NULL CHECK (end_ts > start_ts),
    created_by      BIGINT REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_residence_exhibit ON exhibit_residences (exhibit_id, start_ts);
CREATE INDEX IF NOT EXISTS idx_residence_hall ON exhibit_residences (hall_id, start_ts);

-- 共享照明（规则 19）：保管员以“展厅标识 + 已发生的照明起止 + 正数实际照度 + 非空原因”
-- 登记一次展厅共享照明。照明按与各展品驻留区间的交集归属各展品并跨自然年拆分；
-- 与该展品未作废实测、停灯或已有照明事故相交则整次登记拒绝；无任何展品驻留交集时拒绝。
-- 记录一经写入永久保留：不提供修改/删除接口。
CREATE TABLE IF NOT EXISTS shared_lightings (
    id              BIGSERIAL PRIMARY KEY,
    hall_id         BIGINT NOT NULL REFERENCES halls(id),
    start_ts        TIMESTAMPTZ NOT NULL,
    end_ts          TIMESTAMPTZ NOT NULL CHECK (end_ts > start_ts),
    actual_lux      NUMERIC(10,2) NOT NULL CHECK (actual_lux > 0),
    reason          TEXT NOT NULL,
    created_by      BIGINT REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shared_lighting_hall ON shared_lightings (hall_id, start_ts);

-- 共享照明归属分段：一次共享照明与某条驻留区间的交集（非空）生成一条归属，归属到该展品；
-- 同一驻留对同一次照明至多一条（UNIQUE）。归属分段即该展品的共享照明实际用光窗，
-- 永久保留；驻留被任一行引用即视为“已被照明覆盖”，不得回改。
CREATE TABLE IF NOT EXISTS shared_lighting_allocations (
    id              BIGSERIAL PRIMARY KEY,
    session_id      BIGINT NOT NULL REFERENCES shared_lightings(id) ON DELETE CASCADE,
    residence_id    BIGINT NOT NULL REFERENCES exhibit_residences(id),
    exhibit_id      BIGINT NOT NULL REFERENCES exhibits(id) ON DELETE CASCADE,
    start_ts        TIMESTAMPTZ NOT NULL,
    end_ts          TIMESTAMPTZ NOT NULL CHECK (end_ts > start_ts),
    actual_lux      NUMERIC(10,2) NOT NULL CHECK (actual_lux > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_shared_alloc_session_residence
    ON shared_lighting_allocations (session_id, residence_id);
CREATE INDEX IF NOT EXISTS idx_shared_alloc_exhibit ON shared_lighting_allocations (exhibit_id, start_ts);
CREATE INDEX IF NOT EXISTS idx_shared_alloc_residence ON shared_lighting_allocations (residence_id);

-- 年度用光账册封存（保管员可对展品“已结束的自然年”封存一份不可变账册）。
-- 封存时按当时的固定时区与统一剂量口径原子记录：
--   当年上限、已确认实测剂量合计、各计划“开灯窗 − 已确认实测覆盖 − 本计划停灯”的估算残余、
--   合计（= 实测合计 + 残余合计）及逐项来源（snapshot_json，含每条来源的按年剂量）。
-- 账册一经封存永久不可修改/覆盖（UNIQUE(exhibit_id, year) 兜底，重复提交返回 409）；
-- 封存之后实测纠错、计划状态/调整、上限变化等照常按既有流程生效，本表任何接口都不改写。
CREATE TABLE IF NOT EXISTS annual_ledgers (
    id              BIGSERIAL PRIMARY KEY,
    exhibit_id      BIGINT NOT NULL REFERENCES exhibits(id) ON DELETE CASCADE,
    year            INTEGER NOT NULL CHECK (year BETWEEN 1900 AND 2999),
    limit_lxh       NUMERIC(12,3),
    confirmed_lxh   NUMERIC(12,3) NOT NULL,
    residue_lxh     NUMERIC(12,3) NOT NULL,
    total_lxh       NUMERIC(12,3) NOT NULL,
    snapshot_json   JSONB NOT NULL,
    created_by      BIGINT REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (exhibit_id, year)
);
CREATE INDEX IF NOT EXISTS idx_ledger_exhibit ON annual_ledgers (exhibit_id, year);

-- 展品年度用光额度的分级预警阈值（保管员按展品 + 自然年设置低、高两档，年度上限占比百分比）。
-- 0 < low_pct < high_pct <= 100；未登记年度上限的年份也可设置阈值，但在登记上限前不触发事件。
-- 首次设置/修改阈值时以“当时占用”重建基线（baseline_used_lxh/baseline_level）：
--   * 不补发任何历史事件；
--   * 此后占用向上跨过每档（none→low、low→high；超限仍记 high 档）才各留一条事件，
--     回落后再次向上跨越可重新触发；跨年各自然年独立判定。
-- last_used_lxh/last_level 是最近一次在展品锁事务内重算后的占用与级别（边沿判定用，随占用更新）；
-- 超上限不单独设档：占用比例超过 100% 时仍显示真实占用与“高级”预警。
CREATE TABLE IF NOT EXISTS annual_quota_thresholds (
    id                  BIGSERIAL PRIMARY KEY,
    exhibit_id          BIGINT NOT NULL REFERENCES exhibits(id) ON DELETE CASCADE,
    year                INTEGER NOT NULL CHECK (year BETWEEN 1900 AND 2999),
    low_pct             NUMERIC(7,3) NOT NULL CHECK (low_pct > 0 AND low_pct < 100),
    high_pct            NUMERIC(7,3) NOT NULL CHECK (high_pct > 0 AND high_pct <= 100),
    baseline_used_lxh   NUMERIC(12,3) NOT NULL DEFAULT 0,
    baseline_level      TEXT NOT NULL DEFAULT 'none' CHECK (baseline_level IN ('none','low','high')),
    last_used_lxh       NUMERIC(12,3) NOT NULL DEFAULT 0,
    last_level          TEXT NOT NULL DEFAULT 'none' CHECK (last_level IN ('none','low','high')),
    created_by          BIGINT REFERENCES users(id),
    updated_by          BIGINT REFERENCES users(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (exhibit_id, year),
    CHECK (low_pct < high_pct)
);
CREATE INDEX IF NOT EXISTS idx_quota_threshold_exhibit ON annual_quota_thresholds (exhibit_id, year);

-- 分级预警触发事件（可追溯）。每次“占用向上跨过某档”写一条；回落不写、再次跨越可重触发。
-- 事件只增不改（标记已读只改 read 标记列，不改级别/占用快照）；多展品事务回滚时随事务一并回滚。
CREATE TABLE IF NOT EXISTS annual_quota_alerts (
    id                BIGSERIAL PRIMARY KEY,
    exhibit_id        BIGINT NOT NULL REFERENCES exhibits(id) ON DELETE CASCADE,
    year              INTEGER NOT NULL CHECK (year BETWEEN 1900 AND 2999),
    threshold_id      BIGINT NOT NULL REFERENCES annual_quota_thresholds(id) ON DELETE CASCADE,
    level             TEXT NOT NULL CHECK (level IN ('low','high')),
    trigger_type      TEXT NOT NULL,
    limit_lxh         NUMERIC(12,3),
    used_lxh          NUMERIC(12,3) NOT NULL,
    low_pct           NUMERIC(7,3) NOT NULL,
    high_pct          NUMERIC(7,3) NOT NULL,
    used_pct          NUMERIC(9,3) NOT NULL,
    previous_used_lxh NUMERIC(12,3) NOT NULL,
    previous_level    TEXT NOT NULL CHECK (previous_level IN ('none','low','high')),
    trigger_detail    JSONB,
    created_by        BIGINT REFERENCES users(id),
    read_by           BIGINT REFERENCES users(id),
    read_at           TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_quota_alert_exhibit_year ON annual_quota_alerts (exhibit_id, year, id DESC);
CREATE INDEX IF NOT EXISTS idx_quota_alert_unread ON annual_quota_alerts (exhibit_id) WHERE read_at IS NULL;

-- 既有库升级：补齐已读标记列（首次建库时上述 CREATE TABLE 已包含，IF NOT EXISTS 为空操作）。
ALTER TABLE annual_quota_alerts ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;
ALTER TABLE annual_quota_alerts ADD COLUMN IF NOT EXISTS read_by BIGINT REFERENCES users(id);

-- 按自然年局部重算的派生占用表（annual_usage）：
-- 每行是一件展品某个自然年“按统一剂量口径重算后的当前占用”，全部数字由源数据派生：
--   used_lxh       = 已确认实测 + 计划外照明事故 + 共享照明归属 + 各占用计划估算残余
--   confirmed_lxh / incident_lxh / shared_lxh_lxh / residue_lxh 为各组成部分（供核对/预警）。
-- 所有会改变占用或上限的操作都在原有展品/展厅锁事务内、只重算“本次变更受影响的自然年”，
-- 跨年记录影响到的每个年份各自重算；作废/替换先撤旧贡献再计新贡献（年份并集全量重算）。
-- 单次变更不扫描无关年份的历史记录；派生结果可由 scripts/rebuild-usage.js 全量重建。
-- 重算与业务写入同事务提交或回滚，读取方不会看到新旧占用混杂的状态。
CREATE TABLE IF NOT EXISTS annual_usage (
    exhibit_id      BIGINT NOT NULL REFERENCES exhibits(id) ON DELETE CASCADE,
    year            INTEGER NOT NULL CHECK (year BETWEEN 1900 AND 2999),
    used_lxh        NUMERIC(12,3) NOT NULL DEFAULT 0,
    confirmed_lxh   NUMERIC(12,3) NOT NULL DEFAULT 0,
    incident_lxh    NUMERIC(12,3) NOT NULL DEFAULT 0,
    shared_lxh      NUMERIC(12,3) NOT NULL DEFAULT 0,
    residue_lxh     NUMERIC(12,3) NOT NULL DEFAULT 0,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (exhibit_id, year)
);
CREATE INDEX IF NOT EXISTS idx_annual_usage_exhibit ON annual_usage (exhibit_id, year);

-- 操作流水（审批、确认、状态变更等全部保留）
CREATE TABLE IF NOT EXISTS audit_events (
    id              BIGSERIAL PRIMARY KEY,
    actor_id        BIGINT REFERENCES users(id),
    actor_name      TEXT,
    action          TEXT NOT NULL,
    target_type     TEXT NOT NULL,
    target_id       BIGINT,
    detail          JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_events (target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events (created_at);
