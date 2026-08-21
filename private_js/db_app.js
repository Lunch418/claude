// ════════════════════════════════════════════════════════════════
//  СЭД — db_app.js  (ЯДРО: константы, состояние, шаблоны, utils)
// ════════════════════════════════════════════════════════════════

// API объявлен в db_auth.js
// ── Маппинг колонок дат ──────────────────────────────────────────────────
const DATE_COL_MAP = {
  document:'cdate',resolution:'cdate',dlog:'cdate',document_a:'cdate',document_c:'cdate',
  document_exec:'exec_date',document_f:'cdate',document_n:'reg_date',document_r:'cdate',
  document_read:'cdate',document_task:'cdate',document_delegate:'cdate',
  document_distribution:'cdate',document_control:'cdate',document_og:'cdate',
  notify:'cdate',notify_event:'cdate',medo_event:'cdate',medo_history:'cdate',
  user_sessions:'time',usr_log:'cdate',usr_log_event:'cdate',io_log:'cdate',
  mo_log:'ctime',rlog:'cdate',rt_log:'cdate',resolution_action:'cdate',
  resolution_order:'cdate',exec_history:'cdate',r_execution:'cdate',
  nomenclature_history:'cdate',klp_history:'cdate',db_version:'apply_date',
  news:'cdate',og_appeal:'cdate',og_event:'cdate',og_event_history:'cdate',
  schedule_task:'cdate',schedule_task_status:'cdate',csdr_route_history:'cdate',
  csdr_list_history:'cdate',org_join_log:'cdate',organization_log:'cdate',
};
const DATE_AUTODETECT_PRIORITY = ['cdate','rdate','ddate','created_at','updated_at','date','dt','ts','ctime','time','exec_date','num_date','apply_date','g_mtime'];

// ── Состояние приложения ─────────────────────────────────────────────────
let state = {
  currentDb: 'remote',
  tables:[], currentTable:null, columns:[],
  allRows:[], filteredRows:[],
  page:1, pageSize:100, sortCol:null, sortAsc:true,
  exportFormat:'csv', dateColumn:null,
  orgList:null,
  selectedTmpl:-1,
  tmplParams:{},
  fkByCol:{},
  fkByTableCol:{},
  fkRows:[],
  hiddenColumns: new Set(),
  // Загрузить ещё
  hasMore: false,
  loadOffset: 0,
  lastSql: '',
  lastLimit: 200,
  // true — последняя загрузка списка таблиц реально прошла (даже если
  // нашла 0 таблиц в схеме); false — только при настоящей ошибке
  // (сеть/БД/SQL). Отличает «схема просто пустая» от «нет подключения»
  // в плейсхолдере списка таблиц (db_table.js: renderTableList).
  tablesLoadOk: true,
};

let _sqlBarCollapsed  = true;
let _sqlManuallyEdited = false;

// ════════════════════════════════════════════════════════════════
//  ШАБЛОНЫ SQL
// ════════════════════════════════════════════════════════════════
const TEMPLATES = [
  // ── ДОКУМЕНТЫ ──────────────────────────────────────────────
  { cat:'Документы', title:'Последние документы',
    desc:'Сортировка по дате, выберите количество строк',
    baseTable:'document',
    sqlTemplate:`SELECT
  d.id,
  d.cdate,
  d.exec_date,
  dn.reg_date,
  dn.num,
  dn.category,
  dn.status,
  d.deleted,
  d.short_content,
  u.name AS creator_name,
  ug.name AS reg_org
FROM document d
LEFT JOIN LATERAL (
  SELECT n.reg_date, n.num, n.category, n.status
  FROM document_n n
  WHERE n.document_id = d.id
  ORDER BY n.id DESC
  LIMIT 1
) dn ON true
LEFT JOIN usr u ON u.id = d.creator
LEFT JOIN user_group ug ON ug.id = d.r_org_id
ORDER BY d.id DESC
LIMIT {{limit}}`,
    params:[
      {key:'limit',label:'Строк',type:'int',required:false,default:'100',width:'90px'}
    ]},

  { cat:'Документы', title:'Документы за период',
    desc:'Фильтр по дате создания (cdate)',
    baseTable:'document',
    sqlTemplate:`SELECT
  d.id,
  d.cdate,
  d.exec_date,
  dn.reg_date,
  dn.num,
  dn.category,
  dn.status,
  d.short_content,
  ug.name AS reg_org
FROM document d
LEFT JOIN LATERAL (
  SELECT n.reg_date, n.num, n.category, n.status
  FROM document_n n
  WHERE n.document_id = d.id
  ORDER BY n.id DESC
  LIMIT 1
) dn ON true
LEFT JOIN user_group ug ON ug.id = d.r_org_id
WHERE d.cdate >= COALESCE({{date_from}}::timestamp, '2000-01-01'::timestamp)
  AND d.cdate < (COALESCE({{date_to}}::timestamp, CURRENT_DATE::timestamp) + interval '1 day')
ORDER BY d.cdate DESC
LIMIT {{limit}}`,
    params:[
      {key:'date_from',label:'Дата от',type:'date',required:false},
      {key:'date_to',  label:'Дата до', type:'date',required:false},
      {key:'limit',    label:'Строк',   type:'int', required:false,default:'500',width:'90px'}
    ]},

  { cat:'Документы', title:'Документы по организации',
    desc:'Выберите организацию и период (опционально)',
    baseTable:'document',
    sqlTemplate:`SELECT
  d.id,
  d.cdate,
  dn.num,
  dn.reg_date,
  d.short_content,
  dn.status,
  ug.name AS reg_org
FROM document d
LEFT JOIN LATERAL (
  SELECT n.num, n.reg_date, n.status
  FROM document_n n
  WHERE n.document_id = d.id
  ORDER BY n.id DESC
  LIMIT 1
) dn ON true
LEFT JOIN user_group ug ON ug.id = d.r_org_id
WHERE ({{org_id}} IS NULL OR d.r_org_id = {{org_id}})
  AND ({{date_from}} IS NULL OR d.cdate >= {{date_from}})
  AND ({{date_to}} IS NULL OR d.cdate < ({{date_to}}::timestamp + interval '1 day'))
  AND d.deleted = 0
ORDER BY d.cdate DESC
LIMIT {{limit}}`,
    params:[
      {key:'org_id',   label:'Организация',type:'org', required:false},
      {key:'date_from',label:'Дата от',    type:'date',required:false},
      {key:'date_to',  label:'Дата до',    type:'date',required:false},
      {key:'limit',    label:'Строк',      type:'int', required:false,default:'500',width:'90px'}
    ]},

  { cat:'Документы', title:'Документы без ЭП',
    desc:'Нет ни одной подписанной ЭП (document_a_sign)',
    baseTable:'document',
    sqlTemplate:`SELECT d.id, n.num, d.cdate, u.name AS author, ug.name AS org
FROM document d
JOIN document_a a ON a.document_id = d.id
JOIN usr u ON u.id = a.author
JOIN user_group ug ON ug.id = u.group_id
LEFT JOIN document_n n ON n.document_id = d.id AND n.category IN (1,4)
WHERE NOT EXISTS (
  SELECT 1 FROM document_a_sign das
  JOIN document_a da2 ON da2.id = das.document_a_id
  WHERE da2.document_id = d.id
)
AND ({{org_id}} IS NULL OR ug.id = {{org_id}})
AND ({{date_from}} IS NULL OR d.cdate >= {{date_from}})
AND ({{date_to}} IS NULL OR d.cdate < ({{date_to}}::timestamp + interval '1 day'))
AND d.deleted = 0
ORDER BY d.cdate DESC
LIMIT {{limit}}`,
    params:[
      {key:'org_id',   label:'Организация',type:'org', required:false},
      {key:'date_from',label:'Дата от',    type:'date',required:false},
      {key:'date_to',  label:'Дата до',    type:'date',required:false},
      {key:'limit',    label:'Строк',      type:'int', required:false,default:'200',width:'90px'}
    ]},

  { cat:'Документы', title:'Поиск документа по ID',
    desc:'Полная карточка одного документа',
    baseTable:'document',
    sqlTemplate:`SELECT
  d.*,
  dn.num AS reg_num,
  dn.reg_date AS reg_date,
  dn.category AS reg_category,
  dn.status AS reg_status,
  u.name AS creator_name,
  ug.name AS reg_org
FROM document d
LEFT JOIN LATERAL (
  SELECT n.num, n.reg_date, n.category, n.status
  FROM document_n n
  WHERE n.document_id = d.id
  ORDER BY n.id DESC
  LIMIT 1
) dn ON true
LEFT JOIN usr u ON u.id = d.creator
LEFT JOIN user_group ug ON ug.id = d.r_org_id
WHERE d.id = {{doc_id}}
  AND ({{org_id}} IS NULL OR d.r_org_id = {{org_id}})`,
    params:[
      {key:'doc_id',label:'ID документа',type:'int',required:true,width:'130px'},
      {key:'org_id',label:'Орг. (необяз.)',type:'org',required:false}
    ]},

  { cat:'Документы', title:'Резолюции/поручения по фильтрам',
    desc:'Фильтр по автору, исполнителю, орг документа и периоду',
    baseTable:'resolution',
    sqlTemplate:`SELECT
  dn.document_id AS doc_id,
  dn.org_id      AS doc_org_id,
  dn.num         AS doc_reg_num,
  dn.status      AS doc_status,
  dn.type        AS doc_type,
  dn.reg_user_id AS doc_reg_user_id,
  dn.reg_date    AS doc_reg_date,
  dn.cdate       AS doc_reg_in_time,
  dn.d_deleted   AS doc_deleted,
  r.id           AS resolution_id,
  r.author       AS resolution_author_id,
  r.num          AS resolution_reg_num,
  r.cdate        AS resolution_cdate,
  r.last_modified_date AS resolution_last_modified,
  rt.user_id     AS executor_id,
  rt.exec_date   AS executor_exec_date
FROM resolution r
JOIN resolution_to rt ON rt.resolution_id = r.id
JOIN document_n dn ON dn.document_id = r.document_id
WHERE ({{author_id}} IS NULL OR r.author = {{author_id}})
  AND ({{executor_id}} IS NULL OR rt.user_id = {{executor_id}})
  AND ({{org_id}} IS NULL OR dn.org_id = {{org_id}})
  AND ({{date_from}} IS NULL OR r.cdate >= {{date_from}})
  AND ({{date_to}} IS NULL OR r.cdate < ({{date_to}}::timestamp + interval '1 day'))
ORDER BY r.cdate DESC
LIMIT {{limit}}`,
    params:[
      {key:'author_id',  label:'ID автора резолюции', type:'int', required:false, width:'150px'},
      {key:'executor_id',label:'ID исполнителя',      type:'int', required:false, width:'150px'},
      {key:'org_id',     label:'Организация документа',type:'org',required:false},
      {key:'date_from',  label:'Дата от',            type:'date',required:false},
      {key:'date_to',    label:'Дата до',            type:'date',required:false},
      {key:'limit',      label:'Строк',              type:'int', required:false,default:'500',width:'90px'}
    ]},

  // ── РЕЗОЛЮЦИИ ──────────────────────────────────────────────
  { cat:'Резолюции', title:'Резолюции по документу',
    desc:'Все резолюции к указанному документу',
    baseTable:'resolution',
    sqlTemplate:`SELECT
  r.id,
  r.cdate,
  u.name AS author,
  ug.name AS org
FROM resolution r
LEFT JOIN usr u ON u.id = r.author
LEFT JOIN user_group ug ON ug.id = r.r_org_id
WHERE r.document_id = {{doc_id}}
ORDER BY r.cdate ASC`,
    params:[
      {key:'doc_id',label:'ID документа',type:'int',required:true,width:'130px'}
    ]},

  { cat:'Резолюции', title:'Поручения с исполнителями',
    desc:'Резолюции + исполнители по организации и периоду',
    baseTable:'resolution',
    sqlTemplate:`SELECT DISTINCT
  d.id AS doc_id,
  dn.num AS doc_reg_num,
  r.id AS resolution_id,
  r.num AS resolution_reg_num,
  r.cdate AS resolution_date,
  author.name AS resolution_author,
  ga.name AS author_org,
  isp.name AS executor_name,
  CASE rt.is_resp WHEN 1 THEN 'Да' ELSE '' END AS is_main,
  gi.name AS executor_org,
  rt.exec_date AS executor_exec_date
FROM document d
JOIN LATERAL (
  SELECT n.num, n.reg_date, n.org_id
  FROM document_n n
  WHERE n.document_id = d.id
  ORDER BY n.id DESC
  LIMIT 1
) dn ON true
JOIN resolution r ON r.document_id = d.id
LEFT JOIN usr author ON author.id = r.author
LEFT JOIN user_group ga ON ga.id = r.r_org_id
JOIN resolution_to rt ON rt.resolution_id = r.id
LEFT JOIN usr isp ON isp.id = rt.user_id
LEFT JOIN user_group gi ON gi.id = isp.group_id
WHERE ({{org_id}} IS NULL OR dn.org_id = {{org_id}})
  AND ({{date_from}} IS NULL OR r.cdate >= {{date_from}})
  AND ({{date_to}} IS NULL OR r.cdate < ({{date_to}}::timestamp + interval '1 day'))
ORDER BY d.id, r.cdate DESC
LIMIT {{limit}}`,
    params:[
      {key:'org_id',   label:'Организация документа',type:'org', required:false},
      {key:'date_from',label:'Дата от',              type:'date',required:false},
      {key:'date_to',  label:'Дата до',              type:'date',required:false},
      {key:'limit',    label:'Строк',                type:'int', required:false,default:'500',width:'90px'}
    ]},

  // ── ПОЛЬЗОВАТЕЛИ ───────────────────────────────────────────
  { cat:'Пользователи', title:'Активные пользователи',
    desc:'Не уволенные, подключённые, с подразделением',
    baseTable:'usr',
    sqlTemplate:`SELECT ug.id AS org_id, ug.name AS org_name,
       o.name AS department, u.id, u.name, u.email
FROM user_group ug
JOIN c_org co ON co.org_id = ug.id AND co.dis_date IS NULL
JOIN usr u ON u.group_id = ug.id
LEFT JOIN org o ON o.id = u.org_id
WHERE u.fired = 0 AND u.is_connected = 1
  AND ({{org_id}} IS NULL OR ug.id = {{org_id}})
ORDER BY ug.id, u.id
LIMIT {{limit}}`,
    params:[
      {key:'org_id',label:'Организация',type:'org',required:false},
      {key:'limit', label:'Строк',      type:'int',required:false,default:'500',width:'90px'}
    ]},

  { cat:'Пользователи', title:'Руководители',
    desc:'vip_type 1/2/3 по организации',
    baseTable:'usr',
    sqlTemplate:`SELECT u.id, u.full_name, u.group_id,
       ug.name AS org,
       CASE u.vip_type
         WHEN 1 THEN 'Рук. подразделения'
         WHEN 2 THEN 'Руководство'
         WHEN 3 THEN 'Руководитель'
       END AS role,
       u.phone_number, u.email,
       CASE u.fired WHEN 0 THEN 'Нет' ELSE 'Да' END AS fired
FROM usr u
JOIN user_group ug ON ug.id = u.group_id
JOIN c_org co ON co.org_id = ug.id AND co.dis_date IS NULL
WHERE u.vip_type IN (1,2,3)
  AND ({{org_id}} IS NULL OR u.group_id = {{org_id}})
ORDER BY u.group_id, u.id
LIMIT {{limit}}`,
    params:[
      {key:'org_id',label:'Организация',type:'org',required:false},
      {key:'limit', label:'Строк',      type:'int',required:false,default:'500',width:'90px'}
    ]},

  { cat:'Пользователи', title:'Поиск пользователя',
    desc:'По логину, имени или ФИО',
    baseTable:'usr',
    sqlTemplate:`SELECT u.id, u.login, u.name, u.full_name,
       ug.short_name, o.name AS department,
       u.email, u.phone_number,
       CASE u.fired WHEN 0 THEN 'Нет' ELSE 'Да' END AS fired
FROM usr u
JOIN user_group ug ON ug.id = u.group_id
LEFT JOIN org o ON o.id = u.org_id
WHERE u.login ILIKE {{q_like}}
   OR u.name ILIKE {{q_like}}
   OR u.full_name ILIKE {{q_like}}
ORDER BY u.id
LIMIT {{limit}}`,
    params:[
      {key:'q_like',label:'Имя / логин',type:'like',required:true},
      {key:'limit', label:'Строк',      type:'int', required:false,default:'50',width:'90px'}
    ]},

  { cat:'Пользователи', title:'Последний вход',
    desc:'Дата последней авторизации по организации',
    baseTable:'user_sessions',
    sqlTemplate:`SELECT
  ug.id AS org_id,
  ug.name AS org,
  o.name AS department,
  u.id,
  u.name,
  s.time::date AS last_login_date,
  s.time::time AS last_login_time
FROM user_group ug
JOIN c_org co ON co.org_id = ug.id AND co.dis_date IS NULL
JOIN usr u ON u.group_id = ug.id
LEFT JOIN org o ON o.id = u.org_id
JOIN LATERAL (
  SELECT s2.time
  FROM user_sessions s2
  WHERE s2.user_id = u.id
  ORDER BY s2.time DESC
  LIMIT 1
) s ON true
WHERE ug.id = {{org_id}}
  AND u.fired = 0
ORDER BY u.id
LIMIT {{limit}}`,
    params:[
      {key:'org_id',label:'Организация',type:'org',required:true},
      {key:'limit', label:'Строк',      type:'int',required:false,default:'200',width:'90px'}
    ]},

  { cat:'Пользователи', title:'Руководство + должность',
    desc:'vip_type 2/3, активные, с актуальной должностью (user_post)',
    baseTable:'usr',
    sqlTemplate:`SELECT
  ug.id AS org_id,
  ug.name AS org,
  u.id,
  u.name,
  u.full_name,
  CASE u.vip_type
    WHEN 2 THEN 'Руководство'
    WHEN 3 THEN 'Руководитель'
    ELSE '—'
  END AS role,
  up.post AS post,
  u.phone_number,
  u.email
FROM usr u
JOIN user_group ug ON ug.id = u.group_id
JOIN c_org co ON co.org_id = ug.id AND co.dis_date IS NULL
JOIN user_post up ON up.user_id = u.id AND up.end_date IS NULL AND up.is_deleted = 0
WHERE u.vip_type IN (2,3)
  AND u.fired = 0
  AND u.password <> ''
  AND ({{org_id}} IS NULL OR ug.id = {{org_id}})
ORDER BY ug.id, u.id
LIMIT {{limit}}`,
    params:[
      {key:'org_id',label:'Организация',type:'org',required:false},
      {key:'limit', label:'Строк',      type:'int',required:false,default:'500',width:'90px'}
    ]},

  { cat:'Пользователи', title:'Подведы: пользователи + должность',
    desc:'По superior_org_id (без сессий — включает тех, кто не входил)',
    baseTable:'user_group',
    sqlTemplate:`SELECT
  ug.id   AS org_id,
  ug.name AS org,
  u.id    AS user_id,
  u.name  AS user_name,
  up.post AS post
FROM user_group ug
JOIN usr u ON u.group_id = ug.id AND u.fired = 0 AND u.password <> ''
JOIN user_post up ON up.user_id = u.id AND up.end_date IS NULL AND up.is_deleted = 0
WHERE ug.superior_org_id = {{superior_org_id}}
ORDER BY ug.id, u.id
LIMIT {{limit}}`,
    params:[
      {key:'superior_org_id',label:'ID головной организации',type:'org',required:true},
      {key:'limit',          label:'Строк',                 type:'int',required:false,default:'500',width:'90px'}
    ]},

  { cat:'Пользователи', title:'Подведы: пользователи + последний вход',
    desc:'По superior_org_id (с MAX(time) по user_sessions)',
    baseTable:'user_sessions',
    sqlTemplate:`SELECT
  ug.id   AS org_id,
  ug.name AS org,
  u.id    AS user_id,
  u.name  AS user_name,
  up.post AS post,
  MAX(s.time) AS last_login
FROM user_group ug
JOIN usr u ON u.group_id = ug.id AND u.fired = 0 AND u.password <> ''
JOIN user_post up ON up.user_id = u.id AND up.end_date IS NULL AND up.is_deleted = 0
JOIN user_sessions s ON s.user_id = u.id
WHERE ug.superior_org_id = {{superior_org_id}}
GROUP BY ug.id, ug.name, u.id, u.name, up.post
ORDER BY ug.id, u.id
LIMIT {{limit}}`,
    params:[
      {key:'superior_org_id',label:'ID головной организации',type:'org',required:true},
      {key:'limit',          label:'Строк',                 type:'int',required:false,default:'500',width:'90px'}
    ]},

  // ── ОРГАНИЗАЦИИ ────────────────────────────────────────────
  { cat:'Организации', title:'Подключённые к СЭД',
    desc:'С ИНН и датой подключения',
    baseTable:'user_group',
    sqlTemplate:`SELECT ug.id, ug.short_name, ug.name, ug.tax_number AS inn,
       co.cdate AS connect_date
FROM user_group ug
JOIN c_org co ON co.org_id = ug.id AND co.dis_date IS NULL
ORDER BY ug.id
LIMIT {{limit}}`,
    params:[
      {key:'limit',label:'Строк',type:'int',required:false,default:'100',width:'90px'}
    ]},

  { cat:'Организации', title:'Получают МЭДО',
    desc:'use_medo_notification = 1',
    baseTable:'user_group',
    sqlTemplate:`SELECT ug.id, ug.short_name, ug.name, co.cdate AS connect_date
FROM user_group ug
JOIN c_org co ON co.org_id = ug.id AND co.dis_date IS NULL
WHERE ug.use_medo_notification = 1
ORDER BY ug.id
LIMIT {{limit}}`,
    params:[
      {key:'limit',label:'Строк',type:'int',required:false,default:'100',width:'90px'}
    ]},

  { cat:'Организации', title:'ДСП: подключённые',
    desc:'can_process_dsp = 1 и есть активная запись c_org',
    baseTable:'user_group',
    sqlTemplate:`SELECT ug.id, ug.short_name, ug.name, ug.tax_number AS inn
FROM user_group ug
JOIN c_org co ON co.org_id = ug.id AND co.dis_date IS NULL
WHERE ug.can_process_dsp = 1
ORDER BY ug.id
LIMIT {{limit}}`,
    params:[
      {key:'limit',label:'Строк',type:'int',required:false,default:'100',width:'90px'}
    ]},

  { cat:'Организации', title:'ДСП: не подключённые',
    desc:'can_process_dsp = 1 и нет записи в c_org',
    baseTable:'user_group',
    sqlTemplate:`SELECT ug.id, ug.parent_id, ug.name
FROM user_group ug
WHERE ug.can_process_dsp = 1
  AND NOT EXISTS (SELECT 1 FROM c_org co WHERE co.org_id = ug.id)
ORDER BY ug.id
LIMIT {{limit}}`,
    params:[
      {key:'limit',label:'Строк',type:'int',required:false,default:'100',width:'90px'}
    ]},

  { cat:'Организации', title:'Без руководителя',
    desc:'Нет vip_type 1/2/3 среди активных пользователей',
    baseTable:'user_group',
    sqlTemplate:`SELECT ug.id, ug.name
FROM user_group ug
JOIN c_org co ON co.org_id = ug.id AND co.dis_date IS NULL
WHERE NOT EXISTS (
  SELECT 1 FROM usr u
  WHERE u.group_id = ug.id AND u.vip_type IN (1,2,3) AND u.fired = 0
)
ORDER BY ug.id
LIMIT {{limit}}`,
    params:[
      {key:'limit',label:'Строк',type:'int',required:false,default:'100',width:'90px'}
    ]},

  { cat:'Организации', title:'Структура организации',
    desc:'Подразделения с иерархией',
    baseTable:'org',
    sqlTemplate:`SELECT ug.name AS org, p.name AS parent_dept,
       o.id, o.name AS dept, u.name AS user_name
FROM org o
JOIN org p ON p.id = o.parent_id
JOIN user_group ug ON ug.id = o.group_id
JOIN usr u ON u.group_id = ug.id AND u.org_id = o.id
WHERE o.group_id = {{org_id}}
  AND o.disbanded IS NULL
ORDER BY o.parent_id, o.id
LIMIT {{limit}}`,
    params:[
      {key:'org_id',label:'Организация',type:'org',required:true},
      {key:'limit', label:'Строк',      type:'int',required:false,default:'100',width:'90px'}
    ]},

  // ── МЭДО ───────────────────────────────────────────────────
  { cat:'МЭДО', title:'События МЭДО',
    desc:'История обмена МЭДО',
    baseTable:'medo_history',
    sqlTemplate:`SELECT
  mh.id,
  mh.ctime,
  mh.document_id,
  mh.org_id,
  mh.event_id,
  mh.is_out,
  mh.unsent,
  mh.ready_to_send,
  mh.uuid,
  mh.source_uuid,
  mh.comm_uuid,
  mh.comment,
  mh.iedms_version
FROM medo_history mh
WHERE ({{date_from}} IS NULL OR mh.ctime >= {{date_from}})
  AND ({{date_to}} IS NULL OR mh.ctime < ({{date_to}}::timestamp + interval '1 day'))
ORDER BY mh.ctime DESC, mh.id DESC
LIMIT {{limit}}`,
    params:[
      {key:'date_from',label:'Дата от',type:'date',required:false},
      {key:'date_to',  label:'Дата до',type:'date',required:false},
      {key:'limit',    label:'Строк',  type:'int', required:false,default:'100',width:'90px'}
    ]},

  // ── АНАЛИТИКА / СПРАВОЧНИКИ ────────────────────────────────
  { cat:'Пользователи', title:'Активность пользователей по дате',
    desc:'Последний вход каждого активного сотрудника до указанной даты, с должностью и организацией',
    baseTable:'user_sessions',
    sqlTemplate:`SELECT
  ug.id                  AS org_id,
  ug.name                AS org_name,
  o.name                 AS department,
  u.id                   AS user_id,
  u.name                 AS user_name,
  up.post                AS post,
  s.last_time::DATE      AS last_login_date,
  s.last_time::TIME      AS last_login_time,
  1                      AS login_app
FROM user_group ug
JOIN c_org co  ON co.org_id = ug.id AND co.dis_date IS NULL
JOIN usr u     ON u.group_id = ug.id AND u.fired = 0 AND u.is_connected = 1
JOIN org o     ON o.id = u.org_id
JOIN user_post up ON up.user_id = u.id AND up.end_date IS NULL
JOIN LATERAL (
  SELECT MAX(s2.time) AS last_time
  FROM user_sessions s2
  WHERE s2.user_id = u.id
    AND s2.login_app = 1
    AND s2.time <= COALESCE({{date_to}}::timestamp, CURRENT_DATE::timestamp) + interval '1 day'
) s ON s.last_time IS NOT NULL
ORDER BY ug.id, u.id
LIMIT {{limit}}`,
    params:[
      {key:'date_to', label:'Дата по',  type:'date', required:false},
      {key:'limit',   label:'Строк',    type:'int',  required:false, default:'500', width:'90px'},
    ]},


  { cat:'Аналитика', title:'МЭДО: расхождение рег. номеров',
    desc:'document_n.num ≠ document_medo.foreign_reg_num (несоответствие)',
    baseTable:'document_medo',
    sqlTemplate:`SELECT
  dm.document_id,
  dn.num AS local_reg_num,
  dm.foreign_reg_num,
  dn.reg_date,
  ug.name AS reg_org
FROM document_medo dm
JOIN document_n dn ON dn.document_id = dm.document_id
JOIN user_group ug ON ug.id = dn.org_id
WHERE dm.foreign_reg_num IS NOT NULL
  AND dm.foreign_reg_num <> ''
  AND dn.num IS NOT NULL
  AND dn.num <> dm.foreign_reg_num
  AND ({{org_id}} IS NULL OR dn.org_id = {{org_id}})
  AND ({{date_from}} IS NULL OR dn.reg_date >= {{date_from}})
  AND ({{date_to}} IS NULL OR dn.reg_date < ({{date_to}}::timestamp + interval '1 day'))
ORDER BY dn.reg_date DESC
LIMIT {{limit}}`,
    params:[
      {key:'org_id',   label:'Организация',type:'org', required:false},
      {key:'date_from',label:'Дата от',    type:'date',required:false},
      {key:'date_to',  label:'Дата до',    type:'date',required:false},
      {key:'limit',    label:'Строк',      type:'int', required:false,default:'100',width:'90px'}
    ]},

  { cat:'Справочники', title:'Номенклатура дел',
    desc:'Основные записи по организации',
    baseTable:'nomenclature',
    sqlTemplate:`SELECT n.id, n.name, ug.name AS org
FROM nomenclature n
LEFT JOIN user_group ug ON ug.id = n.group_id
WHERE ({{org_id}} IS NULL OR n.group_id = {{org_id}})
ORDER BY n.id
LIMIT {{limit}}`,
    params:[
      {key:'org_id',label:'Организация',type:'org',required:false},
      {key:'limit', label:'Строк',      type:'int',required:false,default:'100',width:'90px'}
    ]},

  { cat:'Аналитика', title:'Кол-во страниц фактическое',
    desc:'MAX(document_page.n) — фактическое число страниц в PDF',
    baseTable:'document_page',
    sqlTemplate:`SELECT
  ug.id   AS org_id,
  ug.name AS org,
  COUNT(DISTINCT d.id)           AS doc_count,
  SUM(mx.page_count)             AS total_pages,
  AVG(mx.page_count)::numeric(10,1) AS avg_pages
FROM document d
JOIN user_group ug ON ug.id = d.r_org_id
JOIN LATERAL (
  SELECT MAX(p.n) AS page_count
  FROM document_page p
  WHERE p.document_id = d.id
) mx ON true
WHERE mx.page_count > 0
  AND d.deleted = 0
  AND ({{org_id}} IS NULL OR d.r_org_id = {{org_id}})
  AND ({{date_from}} IS NULL OR d.cdate >= {{date_from}})
  AND ({{date_to}} IS NULL OR d.cdate < ({{date_to}}::timestamp + interval '1 day'))
GROUP BY ug.id, ug.name
ORDER BY total_pages DESC
LIMIT {{limit}}`,
    params:[
      {key:'org_id',   label:'Организация',type:'org', required:false},
      {key:'date_from',label:'Дата от',    type:'date',required:false},
      {key:'date_to',  label:'Дата до',    type:'date',required:false},
      {key:'limit',    label:'Строк',      type:'int', required:false,default:'100',width:'90px'}
    ]},

  { cat:'Аналитика', title:'Справочник: category/status/type в document_n',
    desc:'Все встречающиеся значения с количеством документов',
    baseTable:'document_n',
    sqlTemplate:`SELECT
  n.category,
  n.status,
  n.type,
  COUNT(*) AS cnt,
  MIN(n.reg_date) AS first_date,
  MAX(n.reg_date) AS last_date
FROM document_n n
WHERE ({{org_id}} IS NULL OR n.org_id = {{org_id}})
  AND ({{date_from}} IS NULL OR n.reg_date >= {{date_from}})
  AND ({{date_to}} IS NULL OR n.reg_date < ({{date_to}}::timestamp + interval '1 day'))
GROUP BY n.category, n.status, n.type
ORDER BY cnt DESC
LIMIT {{limit}}`,
    params:[
      {key:'org_id',   label:'Организация',type:'org', required:false},
      {key:'date_from',label:'Дата от',    type:'date',required:false},
      {key:'date_to',  label:'Дата до',    type:'date',required:false},
      {key:'limit',    label:'Строк',      type:'int', required:false,default:'100',width:'90px'}
    ]},

  { cat:'Аналитика', title:'Номенклатура: документы + PDF',
    desc:'Дела по номенклатуре с прикреплёнными файлами',
    baseTable:'nomenclature',
    sqlTemplate:`SELECT
  nom.id             AS nom_id,
  nu.num             AS index_num,
  nu.name            AS index_name,
  nu.storage_time    AS year,
  ug.name            AS org,
  dn.document_id     AS doc_id,
  dn.reg_date,
  dn.num             AS reg_num,
  d.short_content,
  df.id              AS file_id,
  df.filename,
  df.filesize,
  dp.id              AS pdf_id
FROM nomenclature nom
JOIN user_group ug ON ug.id = nom.group_id
JOIN nomenclature_unit nu ON nu.nomenclature_id = nom.id
JOIN document_n dn ON dn.nomenclature_unit_id = nu.id
JOIN document d ON d.id = dn.document_id AND d.deleted = 0
LEFT JOIN document_f df ON df.document_id = d.id
LEFT JOIN document_pdf dp ON dp.document_id = d.id
WHERE ({{org_id}} IS NULL OR nom.group_id = {{org_id}})
  AND ({{year}} IS NULL OR nu.storage_time = {{year}})
  AND ({{index_num}} IS NULL OR nu.num ILIKE {{index_num}})
  AND ({{date_from}} IS NULL OR dn.reg_date >= {{date_from}})
  AND ({{date_to}} IS NULL OR dn.reg_date < ({{date_to}}::timestamp + interval '1 day'))
ORDER BY nom.id, dn.document_id
LIMIT {{limit}}`,
    params:[
      {key:'org_id',    label:'Организация', type:'org', required:false},
      {key:'year',      label:'Год', type:'int', required:false, width:'120px'},
      {key:'index_num', label:'Индекс (напр. 01-01)', type:'like', required:false, width:'140px'},
      {key:'date_from', label:'Дата от',     type:'date',required:false},
      {key:'date_to',   label:'Дата до',     type:'date',required:false},
      {key:'limit',     label:'Строк',       type:'int', required:false,default:'100',width:'90px'}
    ]},

  { cat:'Аналитика', title:'Активность: документы по дням',
    desc:'Количество созданных документов по дням в разрезе организации',
    baseTable:'document',
    sqlTemplate:`SELECT
  d.cdate::date   AS day,
  ug.name         AS org,
  COUNT(*)        AS doc_count
FROM document d
JOIN user_group ug ON ug.id = d.r_org_id
WHERE d.deleted = 0
  AND ({{org_id}} IS NULL OR d.r_org_id = {{org_id}})
  AND d.cdate >= COALESCE({{date_from}}::timestamp, CURRENT_DATE::timestamp - interval '30 days')
  AND d.cdate < (COALESCE({{date_to}}::timestamp, CURRENT_DATE::timestamp) + interval '1 day')
GROUP BY d.cdate::date, ug.id, ug.name
ORDER BY day DESC, doc_count DESC
LIMIT {{limit}}`,
    params:[
      {key:'org_id',   label:'Организация',type:'org', required:false},
      {key:'date_from',label:'Дата от',    type:'date',required:false},
      {key:'date_to',  label:'Дата до',    type:'date',required:false},
      {key:'limit',    label:'Строк',      type:'int', required:false,default:'100',width:'90px'}
    ]},

  // ─── Новые шаблоны из Скрипты.docx ───────────────────────────

  { cat:'Пользователи', title:'Списки рассылок',
    desc:'Рассылки организации с пользователями, входящими в рассылку',
    sqlTemplate:`
SELECT
  r_list.id          AS "ID рассылки",
  r_list.name        AS "Наименование рассылки",
  r_list.org_id      AS "ID организации",
  user_group.name    AS "Наименование организации",
  r_list_usr.user_id AS "ID пользователя",
  usr.name           AS "ФИО",
  CASE usr.fired WHEN 0 THEN 'Нет' ELSE 'Да' END AS "Уволен"
FROM r_list, user_group, r_list_usr, usr
WHERE r_list.org_id IS NOT NULL
  AND r_list.org_id = user_group.id
  AND r_list_usr.r_list_id = r_list.id
  AND usr.id = r_list_usr.user_id
  AND ({{org_id}} IS NULL OR r_list.org_id = {{org_id}})
ORDER BY r_list.id, usr.name
LIMIT {{limit}}`,
    params:[
      {key:'org_id', label:'Организация', type:'org',  required:false},
      {key:'limit',  label:'Строк',       type:'int',  required:false, default:'500', width:'90px'}
    ]},

  { cat:'Организации', title:'Неподключённые с неактивными пользователями',
    desc:'Организации always_letter=1 с неактивными пользователями (is_connected=0)',
    sqlTemplate:`
SELECT
  ug.id                   AS "ID организации",
  ug.name                 AS "Наименование организации",
  ug.short_name           AS "Сокращённое наименование",
  ug.postalcode           AS "Почтовый индекс",
  ug.address              AS "Адрес",
  ug.phone                AS "Телефон",
  ug.tax_number           AS "ИНН",
  ug.email                AS "E-mail",
  parent.name             AS "Категория",
  usr.id                  AS "ID пользователя",
  usr.name                AS "Пользователь",
  COALESCE(up.post, 'Нет') AS "Должность"
FROM user_group ug
INNER JOIN user_group AS parent ON parent.id = ug.parent_id
JOIN usr ON usr.group_id = ug.id
JOIN user_post up ON up.user_id = usr.id
WHERE ug.always_letter = 1
  AND usr.is_connected = 0
ORDER BY ug.id, usr.id
LIMIT {{limit}}`,
    params:[
      {key:'limit', label:'Строк', type:'int', required:false, default:'500', width:'90px'}
    ]},

  { cat:'Документы', title:'Поручения с файлами',
    desc:'Поручения по документам с прикреплёнными файлами за период',
    sqlTemplate:`
SELECT DISTINCT
  d.id                    AS "ID документа",
  dp.filename             AS "Наименование документа",
  df.filename             AS "Файл в хранилище",
  df.name                 AS "Пользовательское название",
  df.userfilename         AS "Пользовательское имя файла",
  dn.num                  AS "Рег номер документа",
  r.id                    AS "ID резолюции",
  r.num                   AS "Рег номер резолюции",
  r.cdate                 AS "Дата резолюции",
  author.name             AS "Автор резолюции",
  grp_a.name              AS "Орг автора",
  isp.name                AS "Исполнитель",
  CASE rt.is_main_executor WHEN 1 THEN 'Да' ELSE ' ' END AS "Отв. исполнитель",
  grp_i.name              AS "Орг исполнителя"
FROM document d
JOIN document_n dn ON dn.document_id = d.id
JOIN document_pdf dp ON dp.document_id = d.id
JOIN document_f df ON df.document_id = d.id
JOIN resolution r ON r.document_id = d.id
INNER JOIN usr AS author ON r.author = author.id
INNER JOIN user_group AS grp_a ON r.r_org_id = grp_a.id
JOIN resolution_to rt ON rt.resolution_id = r.id
INNER JOIN usr AS isp ON rt.user_id = isp.id
INNER JOIN user_group AS grp_i ON grp_i.id = isp.group_id
WHERE isp.group_id = {{org_id}}
  AND r.cdate >= COALESCE({{date_from}}::timestamp, '2000-01-01'::timestamp)
  AND r.cdate < (COALESCE({{date_to}}::timestamp, CURRENT_DATE::timestamp) + interval '1 day')
  AND dn.org_id = {{org_id}}
ORDER BY d.id, r.cdate
LIMIT {{limit}}`,
    params:[
      {key:'org_id',    label:'Организация', type:'org',  required:true},
      {key:'date_from', label:'Дата от',      type:'date', required:false},
      {key:'date_to',   label:'Дата до',      type:'date', required:false},
      {key:'limit',     label:'Строк',        type:'int',  required:false, default:'1000', width:'90px'}
    ]},

  { cat:'Документы', title:'Документы с ключевыми словами',
    desc:'Документы по ключевым словам в кратком содержании за период',
    sqlTemplate:`
SELECT DISTINCT
  d.id               AS "ID документа",
  dn.num             AS "Рег номер",
  d.short_content    AS "Краткое содержание",
  d.cdate            AS "Дата документа",
  author.name        AS "От кого",
  grp_a.name         AS "Орг автора",
  recip.name         AS "Кому",
  grp_r.name         AS "Орг адресата"
FROM document d
JOIN document_n dn ON dn.document_id = d.id
JOIN document_a da ON da.document_id = d.id
INNER JOIN usr AS author ON da.author = author.id
INNER JOIN user_group AS grp_a ON author.group_id = grp_a.id
JOIN document_r dr ON dr.document_id = d.id
INNER JOIN usr AS recip ON dr.recipient = recip.id
INNER JOIN user_group AS grp_r ON grp_r.id = recip.group_id
WHERE dn.num NOT LIKE 'согл%'
  AND d.cdate >= COALESCE({{date_from}}::timestamp, '2000-01-01'::timestamp)
  AND d.cdate < (COALESCE({{date_to}}::timestamp, CURRENT_DATE::timestamp) + interval '1 day')
  AND d.short_content ILIKE {{keyword}}
ORDER BY d.id, recip.name
LIMIT {{limit}}`,
    params:[
      {key:'date_from', label:'Дата от',         type:'date', required:false},
      {key:'date_to',   label:'Дата до',          type:'date', required:false},
      {key:'keyword',   label:'Ключевое слово',   type:'like', required:true, default:'О предоставлении%'},
      {key:'limit',     label:'Строк',            type:'int',  required:false, default:'500', width:'90px'}
    ]},

  { cat:'Документы', title:'Последнее использование МО',
    desc:'Последний вход руководства/руководителей через мобильное приложение',
    sqlTemplate:`
SELECT
  usr.id                AS "ID пользователя",
  usr.full_name         AS "ФИО",
  usr.group_id          AS "ID организации",
  ug.name               AS "Название организации",
  CASE usr.vip_type
    WHEN 2 THEN 'Руководство'
    ELSE 'Руководитель'
  END                   AS "Категория должности",
  MAX(ml.ctime)         AS "Последнее использование МО"
FROM usr, user_group ug, mo_log ml
WHERE ug.id = usr.group_id
  AND usr.vip_type IN (2, 3)
  AND usr.fired = 0
  AND ml.user_id = usr.id
  AND ({{org_id}} IS NULL OR ug.id = {{org_id}})
GROUP BY usr.id, usr.full_name, usr.group_id, ug.name, usr.vip_type
ORDER BY usr.group_id, usr.id
LIMIT {{limit}}`,
    params:[
      {key:'org_id', label:'Организация', type:'org',  required:false},
      {key:'limit',  label:'Строк',       type:'int',  required:false, default:'500', width:'90px'}
    ]},

  { cat:'Организации', title:'Подчинённые организации',
    desc:'Организации, подчинённые указанной (superior_org_id)',
    sqlTemplate:`
SELECT
  ug.superior_org_id  AS "ID головной орг",
  main_org.name       AS "Наименование головной орг",
  ug.id               AS "ID подчинённой орг",
  ug.name             AS "Наименование подчинённой орг",
  ug.tax_number       AS "ИНН"
FROM user_group ug
INNER JOIN user_group AS main_org ON ug.superior_org_id = main_org.id
WHERE ug.superior_org_id = {{org_id}}
ORDER BY ug.id
LIMIT {{limit}}`,
    params:[
      {key:'org_id', label:'Головная организация', type:'org',  required:true},
      {key:'limit',  label:'Строк',                 type:'int',  required:false, default:'500', width:'90px'}
    ]},

  { cat:'Документы', title:'Передача прав на документы',
    desc:'Кто кому передавал права на документы (document_delegate)',
    sqlTemplate:`
SELECT
  dd.id                AS "ID",
  dd.src_user_id       AS "ID от кого",
  kto.name             AS "Кто",
  grp_kto.name         AS "Орг (кто)",
  dd.dest_user_id      AS "ID кому",
  komu.name            AS "Кому",
  grp_komu.name        AS "Орг (кому)",
  dd.n                 AS "Кол-во документов"
FROM document_delegate dd
INNER JOIN usr AS kto   ON dd.src_user_id  = kto.id
INNER JOIN user_group AS grp_kto  ON kto.group_id  = grp_kto.id
INNER JOIN usr AS komu  ON dd.dest_user_id = komu.id
INNER JOIN user_group AS grp_komu ON komu.group_id = grp_komu.id
WHERE 1=1
  AND ({{org_id}} IS NULL OR grp_kto.id = {{org_id}} OR grp_komu.id = {{org_id}})
ORDER BY dd.src_user_id, grp_kto.id
LIMIT {{limit}}`,
    params:[
      {key:'org_id', label:'Организация', type:'org',  required:false},
      {key:'limit',  label:'Строк',       type:'int',  required:false, default:'500', width:'90px'}
    ]},

  { cat:'Документы', title:'Сводные поручения / протоколы',
    desc:'Документы с видом «протокол» (document_kind=12) и категорией 5 за период',
    sqlTemplate:`
SELECT
  d.id                 AS "ID документа",
  d.short_content      AS "Краткое содержание",
  d.cdate              AS "Дата создания",
  dn.num               AS "Номер",
  dn.category          AS "Категория",
  ug.name              AS "Организация"
FROM document d
JOIN document_n dn ON dn.document_id = d.id
JOIN user_group ug  ON ug.id = dn.org_id
JOIN c_org         ON c_org.org_id = ug.id
WHERE d.document_kind = 12
  AND dn.category = 5
  AND d.cdate >= COALESCE({{date_from}}::timestamp, '2000-01-01'::timestamp)
  AND d.cdate < (COALESCE({{date_to}}::timestamp, CURRENT_DATE::timestamp) + interval '1 day')
  AND dn.d_deleted = 0
  AND dn.num NOT LIKE 'согл%'
  AND dn.n = 0
  AND d.parent_id IS NULL
  AND ({{org_id}} IS NULL OR ug.id = {{org_id}})
ORDER BY d.id
LIMIT {{limit}}`,
    params:[
      {key:'org_id',    label:'Организация', type:'org',  required:false},
      {key:'date_from', label:'Дата от',      type:'date', required:false},
      {key:'date_to',   label:'Дата до',      type:'date', required:false},
      {key:'limit',     label:'Строк',        type:'int',  required:false, default:'1000', width:'90px'}
    ]},

  { cat:'Организации', title:'Бланки организации',
    desc:'Папки и бланки документов для выбранной организации',
    sqlTemplate:`
SELECT
  bf.org_id          AS "ID организации",
  ug.name            AS "Организация",
  b.blank_folder_id  AS "ID папки",
  bf.title           AS "Наименование папки",
  b.id               AS "ID бланка",
  b.title            AS "Наименование бланка",
  b.filename         AS "Имя файла",
  b.userfilename     AS "Имя файла (пользователь)"
FROM blanks b
JOIN blank_folders bf ON b.blank_folder_id = bf.id
JOIN user_group ug    ON ug.id = bf.org_id
WHERE 1=1
  AND ({{org_id}} IS NULL OR bf.org_id = {{org_id}})
ORDER BY ug.id, bf.id, b.id
LIMIT {{limit}}`,
    params:[
      {key:'org_id', label:'Организация', type:'org',  required:false},
      {key:'limit',  label:'Строк',       type:'int',  required:false, default:'1000', width:'90px'}
    ]},

  { cat:'Документы', title:'Перенаправленные документы',
    desc:'Документы, перенаправленные от одного пользователя другому через резолюцию',
    sqlTemplate:`
SELECT
  dn.document_id      AS "ID документа",
  dn.org_id           AS "ID орг",
  dn.num              AS "Рег номер",
  dn.status           AS "Статус",
  dn.reg_date         AS "Дата регистрации",
  r.id                AS "ID резолюции",
  r.author            AS "ID автора резолюции",
  r.num               AS "Номер резолюции",
  r.cdate             AS "Дата резолюции",
  rt.user_id          AS "ID исполнителя"
FROM document_n dn
JOIN resolution r    ON r.document_id = dn.document_id
JOIN resolution_to rt ON rt.resolution_id = r.id
WHERE r.author    = {{author_id}}
  AND rt.user_id  = {{recipient_id}}
  AND dn.org_id   = {{org_id}}
  AND r.cdate >= COALESCE({{date_from}}::timestamp, '2000-01-01'::timestamp)
ORDER BY r.cdate
LIMIT {{limit}}`,
    params:[
      {key:'org_id',       label:'Организация',    type:'org',  required:true},
      {key:'author_id',    label:'ID автора',       type:'int',  required:true},
      {key:'recipient_id', label:'ID исполнителя',  type:'int',  required:true},
      {key:'date_from',    label:'Дата от',          type:'date', required:false},
      {key:'limit',        label:'Строк',            type:'int',  required:false, default:'200', width:'90px'}
    ]},

  { cat:'Аналитика', title:'Корреспонденты vs Абоненты МЭДО',
    desc:'Сравнение корреспондентов (parent_id=33734) и абонентов medo_org',
    sqlTemplate:`
SELECT
  'Корреспондент МЭДО (нет в medo_org)' AS "Тип",
  ug.id, ug.name, ug.short_name
FROM user_group ug
WHERE ug.parent_id = 33734
  AND NOT EXISTS (SELECT 1 FROM medo_org mo WHERE mo.group_id = ug.id)
UNION ALL
SELECT
  'Абонент МЭДО (нет в корреспондентах)',
  mo.group_id, mo.name, NULL
FROM medo_org mo
WHERE NOT EXISTS (
  SELECT 1 FROM user_group ug
  WHERE ug.parent_id = 33734 AND ug.id = mo.group_id
)
ORDER BY 1, 2
LIMIT {{limit}}`,
    params:[
      {key:'limit', label:'Строк', type:'int', required:false, default:'200', width:'90px'}
    ]},

  { cat:'Аналитика', title:'Активные запросы к БД',
    desc:'pg_stat_activity — все не idle процессы, отсортированы по времени старта',
    adminOnly: true,
    sqlTemplate:`SELECT
  pid,
  datname,
  usename,
  state,
  query_start,
  now() - query_start AS duration,
  query
FROM pg_stat_activity
WHERE state <> 'idle'
ORDER BY query_start DESC`,
    params:[]},

];

// ════════════════════════════════════════════════════════════════
//  УТИЛИТЫ
// ════════════════════════════════════════════════════════════════
const _RU2 = 'йцукенгшщзхъфывапролджэячсмитьбю.ЙЦУКЕНГШЩЗХЪФЫВАПРОЛДЖЭЯЧСМИТЬБЮ,';
const _EN2 = "qwertyuiop[]asdfghjkl;'zxcvbnm,./QWERTYUIOP{}ASDFGHJKL:\"ZXCVBNM<>?";
const _LMAP = {};
for (let i = 0; i < _RU2.length; i++) { _LMAP[_RU2[i]] = _EN2[i]; _LMAP[_EN2[i]] = _RU2[i]; }
function convertLayout(str) { return str.split('').map(c => _LMAP[c] || c).join(''); }

function matchSearch(text, q) {
  if (!q) return true;
  const tl = text.toLowerCase(), ql = q.toLowerCase();
  return tl.includes(ql) || tl.includes(convertLayout(ql));
}

function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function replaceAll(str, search, replacement) {
  return str.split(search).join(replacement);
}

// ════════════════════════════════════════════════════════════════
//  ТАБЛИЦЫ (белый список)
// ════════════════════════════════════════════════════════════════
const TABLE_WHITELIST = ['document','resolution','usr','user_group','blanks','blank_folders','blank_folders_access','c_org','concurrent_csdr_status','control_author','covering_letter','course','course_item','course_role','csdr_list_doc_type','csdr_list_history','csdr_list_users','csdr_route','csdr_route_stage','csdr_route_stage_r_list','csdr_route_stage_user','csdr_route_history','curator_data','db_version','db_version_script','digital_sign','dlog','document_a','document_a_sign','document_c','document_c_return','document_c_type','document_c_version','document_c_version_to','document_c_version_to_f','document_c_version_to_r','document_control','document_curator','document_category_change_history','document_delegate','document_delegate_history','document_distribution','document_distribution_history','document_delivery_types','document_exec','document_f','document_f_sign','document_from','document_in_b','document_in_d','document_index','document_indexed','document_kind','document_kind_list','document_kind_mapping','document_medo','document_memo','document_mosru','document_mosru_data','document_mont_folder','document_n','document_number_template','document_og','document_og_a','document_og_s_tree','document_og_file_sending_status','document_org','document_page','document_page_angle','document_page_bookmark','document_page_group','document_page_layer','document_page_content','document_pdf','document_pdf_version','document_r','document_r_list','document_read','document_refuse_reg','document_refuse_reg_reply','document_res_bookmark','document_resp_user','document_recognized','document_repair','document_reconsideration','document_sd','document_sd_log','document_seq_lock','document_special_kind','document_status','document_sending_list','document_tag','document_tag_bind','document_tag_group','document_tag_group_participant','document_task','document_text','document_urgency','document_user','document_user_access','document_user_sign','du2_login','ef_reason','ef_reason_category','errand_app_badge','errand_app_token','event','event_notification','exec_event','exec_date_flag','exec_event_d','exec_history','execution_verification','government_category','government_category_group','io_log','klp','klp_in_document','klp_history','klp_to_og_classifier','lazy_password','mail_address_from','mail_address_to','manual_print','mark_all_print_log','mark_all_read_log','medo_document_kind','medo_event','medo_history','medo_history_ack','medo_history_container','medo_org','medo_org_history','medo_sync','message','message_text','mo_log','mo_log_event','mont_folder','mont_log','mont_update','mosru_og_status','news','nom_numerator_template_items','nom_numerator_templates','nomenclature','nomenclature_history','nomenclature_print_settings','nomenclature_rule','nomenclature_rule_group','nomenclature_unit','nomenclature_unit_history','nomenclature_user','nomenclature_document_category','notification_blank','notification_blank_build','notification_blank_build_snapshot','notification_blank_signer','notification_blank_snapshot','notification_blank_template','notification_blank_type','notification_custom_blank_group','notification_custom_blank_state','notify','notify_event','notify_event_user','object_gas_id','org','org_folder','org_folder_document','org_join_log','org_mark','org_mark_group','org_mark_relation','organization_log','pcalendar','phrases','printed_document','project_control','project_document_delivery_types','project_exec_date_flag','push_event','push_event_user','push_user_token','push_queue','r_execution','r_exec_f_log','r_execution_d','r_execution_f','r_list','r_list_usr','recipient_autoreplace_rule','refuse_reason','release_notify','release_notify_usr','remote_user_sessions','report_datas','resolution_action','resolution_bulk_csdr','resolution_bulk_history','resolution_bundle','resolution_mo_text','resolution_notice','resolution_order','resolution_order_log','resolution_r_list','resolution_sent_without_project','resolution_subject','resolution_to','rlog','rt_log','schedule_server','schedule_task','schedule_task_status','sd_doc_persons','sd_requests','search_template','single_registration_group_org','sstu_group','sstu_request','sstu_status','structure_department','substitution','substitution_post','support_file','support_log','support_section','survey','survey_answers','survey_question','survey_question_variant','tag','texecutor','texecutor_group','texecutor_group_exec','texecutor_user','texecutor_user_data','user_behalf_fav','user_certificate','user_device_folder','user_devices','user_distribute_fav','user_executor','user_executor_fav','user_folder','user_folder_document','user_history','user_m_assign','user_m_folder','user_m_folder_document','user_notify','user_notify_sent','user_options','user_permission','user_permission_department','user_permission_history','user_post','user_sessions','user_sogl_fav','user_trustee','usr_join_log','usr_log','usr_log_event'];

const TABLE_LABELS_FALLBACK = {blanks:'Бланки (шаблоны бланков)',blank_folders:'Папки бланков',course:'Курсы / обучающие маршруты',course_item:'Элементы курса',course_role:'Роли курса',csdr_list_doc_type:'Типы документов (ЦСДР)',csdr_list_history:'История справочников (ЦСДР)',csdr_list_users:'Пользователи (ЦСДР)',medo_history:'История обмена МЭДО',medo_sync:'Синхронизация МЭДО',notify:'Уведомления',notify_event:'События уведомлений',notify_event_user:'Получатели уведомлений',org_mark:'Метки организации',org_mark_group:'Группы меток',org_mark_relation:'Связи меток',push_event_user:'Push-события пользователей',push_user_token:'Токены Push',r_exec_f_log:'Лог исполнения (файлы)',report_datas:'Данные для отчётов',resolution_bulk_history:'История массовых операций',resolution_subject:'Темы резолюций',schedule_task:'Задачи планировщика',sstu_group:'Группы ССТУ',sstu_status:'Статусы ССТУ',user_devices:'Устройства пользователей',user_history:'История пользователя',user_options:'Настройки пользователя',document_og_s_tree:'Дерево связей ОГ',document_reconsideration:'Повторное рассмотрение',errand_app_badge:'Бейджи (поручения)',errand_app_token:'Токены (поручения)',klp:'КЛП — листы поручений',klp_history:'История КЛП',klp_to_og_classifier:'КЛП ↔ классификатор ОГ',medo_history_container:'Контейнеры истории МЭДО'};

// ════════════════════════════════════════════════════════════════
//  API
// ════════════════════════════════════════════════════════════════
const _pendingCalls = new Map();

async function apiCall(sql, mode = 'preview', limit = 1000) {
  const key = sql + '|' + mode + '|' + limit + '|' + (state.currentDb||'remote') + '|' + (state.chedSchema||'');

  // Если уже летит такой же запрос — возвращаем тот же Promise
  if (_pendingCalls.has(key)) return _pendingCalls.get(key);

  // Локальная БД — через Local:query напрямую
  if (state.currentDb === 'local') {
    const localLimit = limit > 0 ? limit : 5000; // limit=0 означает "без ограничения" → берём максимум
    const lp = fetch(`${API}?m=Local&a=query`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin', body: JSON.stringify({ sql, limit: localLimit }),
    }).then(async r => {
      if (r.status === 401) { window._handleUnauthorized?.(); throw new Error('Сессия истекла'); }
      const t = await r.text(); return t?.trim() ? JSON.parse(t) : { ok:true, columns:[], rows:[], count:0 };
    }).finally(() => _pendingCalls.delete(key));
    _pendingCalls.set(key, lp); return lp;
  }

  const _profile = (state.currentDb === 'ched' || state.currentDb === 'ched2' || state.currentDb === 'ksp' || state.currentDb === 'monitoring') ? state.currentDb : 'sed';
  const _schema  = _profile !== 'sed' ? (state.chedSchema || '') : '';

  const promise = fetch(`${API}?m=Remote&a=preview`, {
    method:      'POST',
    headers:     { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body:        JSON.stringify({ sql, mode, limit, profile: _profile, schema: _schema }),
  })
  .then(async resp => {
    if (resp.status === 401) {
      if (typeof window._handleUnauthorized === 'function') window._handleUnauthorized();
      throw new Error('Сессия истекла, войдите снова');
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    if (!text?.trim()) return { ok: true, columns: [], rows: [], count: 0 };
    return JSON.parse(text);
  })
  .finally(() => _pendingCalls.delete(key));  // после завершения — убираем из Map

  _pendingCalls.set(key, promise);
  return promise;
}

// ════════════════════════════════════════════════════════════════
//  INIT — вызывается из db_auth.js после успешного входа
// ════════════════════════════════════════════════════════════════
let _initCalled = false;

// ── Локальный SQL модал ───────────────────────────────────────
function openLocalSqlModal() {
  document.getElementById('localSqlModal')?.classList.add('open');
  document.getElementById('localSqlEditor')?.focus();
}
function closeLocalSqlModal() {
  document.getElementById('localSqlModal')?.classList.remove('open');
}

async function runLocalSql() {
  const sql = document.getElementById('localSqlEditor')?.value?.trim();
  const statusEl = document.getElementById('localSqlStatus');
  const resultEl = document.getElementById('localSqlResult');
  if (!sql) return;

  statusEl.textContent = 'Выполняется...';
  resultEl.innerHTML = '<div class="placeholder" style="height:100px"><div class="loading-spinner"></div></div>';

  try {
    const t0 = Date.now();
    const r = await fetch(`${API}?m=Local&a=query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ sql, limit: 5000 }),
    });
    const data = await r.json();
    const elapsed = ((Date.now() - t0) / 1000).toFixed(2);

    if (!data.ok) {
      statusEl.textContent = '';
      resultEl.innerHTML = `<div class="placeholder" style="height:80px;color:var(--c-red);font-size:12px">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="12.5"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        ${escHtml(data.error || 'Ошибка')}
      </div>`;
      return;
    }

    statusEl.textContent = `${data.count} строк · ${elapsed}s`;

    if (!data.rows?.length) {
      resultEl.innerHTML = '<div class="placeholder" style="height:80px;font-size:12px">Нет данных</div>';
      return;
    }

    // Рендерим таблицу
    const cols = data.columns || [];
    const ths = cols.map(c => `<th style="padding:5px 10px;text-align:left;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--c-text-3);white-space:nowrap;border-bottom:1px solid var(--c-border)">${escHtml(c)}</th>`).join('');
    const trs = data.rows.map(row =>
      '<tr>' + cols.map(c => {
        const v = row[c]; const s = v == null ? '' : String(v);
        return `<td style="padding:4px 10px;font-size:12px;border-bottom:1px solid var(--c-border-soft);white-space:nowrap;max-width:300px;overflow:hidden;text-overflow:ellipsis" title="${escHtml(s)}">${escHtml(s.length > 120 ? s.slice(0,120)+'…' : s)}</td>`;
      }).join('') + '</tr>'
    ).join('');

    resultEl.innerHTML = `<div style="overflow:auto;height:100%">
      <table style="width:100%;border-collapse:collapse;font-family:var(--font-mono)">
        <thead style="position:sticky;top:0;background:var(--c-surface-2)"><tr>${ths}</tr></thead>
        <tbody>${trs}</tbody>
      </table>
    </div>`;
  } catch (e) {
    statusEl.textContent = '';
    resultEl.innerHTML = `<div class="placeholder" style="height:80px;color:var(--c-red);font-size:12px">${escHtml(e.message)}</div>`;
  }
}

// Закрытие по клику на overlay
document.addEventListener('mousedown', e => {
  const m = document.getElementById('localSqlModal');
  if (m?.classList.contains('open') && e.target === m) closeLocalSqlModal();
});

// Ctrl+Enter в редакторе
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('localSqlEditor')?.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runLocalSql(); }
  });
});

// Отображаемое имя внешнего источника для статус-сообщений
// (раньше везде было захардкожено «CHED» — вводило в заблуждение на
// KSP/АИС Мониторинг: писало «CHED · public: 0 таблиц» вместо реального имени).
function _remoteLabel(db) {
  return db === 'ched' ? 'CHED'
       : db === 'ched2' ? 'CHED2'
       : db === 'ksp' ? 'КСП'
       : db === 'monitoring' ? 'АИС Мониторинг'
       : 'CHED';
}

// ── Переключение БД (только для админа) ──────────────────────
function switchDb(db) {
  // Локальная БД — только админ; CHED/CHED2/SED — админ или разрешённое ФИО
  if (db === 'local') {
    if (!isCurrentUserAdmin()) return;
  } else if (!canUseRemote()) {
    return;
  }
  state.currentDb = db;
  document.getElementById('dbItemRemote')?.classList.toggle('active', db === 'remote');
  document.getElementById('dbItemLocal')?.classList.toggle('active', db === 'local');
  document.getElementById('dbItemChed')?.classList.toggle('active', db === 'ched');
  document.getElementById('dbItemChed2')?.classList.toggle('active', db === 'ched2');
  document.getElementById('dbItemKsp')?.classList.toggle('active', db === 'ksp');
  document.getElementById('dbItemMonitoring')?.classList.toggle('active', db === 'monitoring');
  document.getElementById('logoDbLabel').textContent =
    db === 'local' ? '/ log' : db === 'ched' ? '/ ched' : db === 'ched2' ? '/ ched2' : db === 'ksp' ? '/ ksp' : db === 'monitoring' ? '/ мониторинг' : '/ doc';
  const _chedSel = document.getElementById('chedSchemaSelect');
  if (_chedSel) _chedSel.style.display = (db === 'ched' || db === 'ched2' || db === 'ksp' || db === 'monitoring') ? '' : 'none';
  if (typeof window.__resetSqlSchema === 'function') window.__resetSqlSchema();
  document.getElementById('dbSwitchDropdown').style.display = 'none';

  // Иконки логотипа
  const iconRemote = document.getElementById('logoIconRemote');
  const iconLocal  = document.getElementById('logoIconLocal');
  if (iconRemote) iconRemote.style.display = db === 'local' ? 'none' : '';
  if (iconLocal)  iconLocal.style.display  = db === 'local' ? '' : 'none';

  // Сброс состояния
  state.tables = []; state.currentTable = ''; state.allRows = [];
  state.filteredRows = []; state.columns = []; state.selectedTmpl = -1;
  document.getElementById('tableArea').innerHTML = '';
  document.getElementById('currentTable').textContent = '';

  const fkBadge       = document.getElementById('fkBadge');
  const tblCountBadge = document.getElementById('tblCountBadge');
  const tabTemplates  = document.getElementById('tab-templates');
  const tabSaved      = document.getElementById('tab-saved');
  const sqlWrap       = document.getElementById('localSqlOpenWrap');

  if (db === 'local') {
    if (tabTemplates) tabTemplates.style.display = 'none';
    if (tabSaved)     tabSaved.style.display     = 'none';
    if (fkBadge)     { fkBadge.style.display = 'none'; }
    if (sqlWrap)     sqlWrap.style.display = '';
    if (typeof switchTab === 'function') switchTab('tables');
    state.tables = [
      { name: 'sed_query_log',  comment: 'Лог запросов' },
      { name: 'sed_user_prefs', comment: 'Настройки пользователей' },
    ];
    if (tblCountBadge) tblCountBadge.textContent = '2 таблицы';
    document.getElementById('tblCount').textContent = '2 таблицы';
    if (typeof renderTableList === 'function') {
      const list = document.getElementById('tableList');
      if (list) list.dataset.renderedFilter = '__reset__';
      renderTableList('');
    }
    setStatus('ok', 'Локальная БД: sed_log');
  } else if (db === 'ched' || db === 'ched2' || db === 'ksp' || db === 'monitoring') {
    // CHED/CHED2/KSP/monitoring — внешняя база, таблицы зависят от выбранной схемы
    state.chedSchema = '';                 // у новой базы свой список схем
    if (tabTemplates) tabTemplates.style.display = 'none';
    if (tabSaved)     tabSaved.style.display     = '';
    if (sqlWrap)      sqlWrap.style.display = 'none';
    if (fkBadge)     { fkBadge.style.display = 'none'; }
    if (typeof switchTab === 'function') switchTab('tables');
    const tableList = document.getElementById('tableList');
    if (tableList) {
      tableList.dataset.renderedFilter = '__reset__';
      tableList.innerHTML = '<div class="placeholder" style="height:120px"><div class="loading-spinner"></div><div style="font-size:12px;margin-top:6px;color:var(--c-text-3)">Загрузка схем...</div></div>';
    }
    setStatus('ok', `${_remoteLabel(db)}: загрузка схем...`);
    loadChedSchemas();
  } else {
    if (tabTemplates) tabTemplates.style.display = '';
    if (tabSaved)     tabSaved.style.display     = '';
    if (sqlWrap)      sqlWrap.style.display = 'none';
    // Сброс списка таблиц и перезагрузка
    const tableList = document.getElementById('tableList');
    if (tableList) {
      tableList.dataset.renderedFilter = '__reset__';
      tableList.innerHTML = '<div class="placeholder" style="height:120px"><div class="loading-spinner"></div><div style="font-size:12px;margin-top:6px;color:var(--c-text-3)">Загрузка из БД...</div></div>';
    }
    if (typeof loadTableList === 'function') loadTableList();
    if (typeof loadFkRelations === 'function') loadFkRelations();
  }
}

// ── CHED: загрузка схем и таблиц выбранной схемы ─────────────
async function loadChedSchemas() {
  const sel = document.getElementById('chedSchemaSelect');
  try {
    // has_tables — считаем сразу тут же (одним запросом), чтобы по
    // умолчанию выбирать НЕ первую по алфавиту схему (часто это пустой
    // 'public'), а первую, где реально что-то есть.
    const sql =
      "SELECT n.nspname AS schema_name, EXISTS (" +
      "  SELECT 1 FROM pg_class c WHERE c.relnamespace = n.oid AND c.relkind IN ('r','v','m','p','f')" +
      ") AS has_tables " +
      "FROM pg_namespace n " +
      "WHERE n.nspname NOT IN ('pg_catalog','information_schema') " +
      "AND n.nspname NOT LIKE 'pg_temp%' AND n.nspname NOT LIKE 'pg_toast%' " +
      "ORDER BY n.nspname";
    const res = await apiCall(sql, 'preview', 1000);
    if (!res || !res.ok) {
      state.tablesLoadOk = false;
      setError((res && res.error) || `Не удалось загрузить схемы (${_remoteLabel(state.currentDb)})`);
      return;
    }
    const schemaRows = (res.rows || []).filter(r => r.schema_name);
    const schemas = schemaRows.map(r => r.schema_name);
    if (sel) sel.innerHTML = schemas.map(s =>
      `<option value="${s.replace(/"/g, '&quot;')}">${s}</option>`).join('');
    if (!schemas.length) { setStatus('ok', `${_remoteLabel(state.currentDb)}: схемы не найдены`); return; }
    const nonEmpty = schemaRows.find(r => r.has_tables === true || r.has_tables === 't')?.schema_name;
    const want = (state.chedSchema && schemas.includes(state.chedSchema)) ? state.chedSchema : (nonEmpty || schemas[0]);
    state.chedSchema = want;
    if (sel) sel.value = want;
    if (typeof window.__resetSqlSchema === 'function') window.__resetSqlSchema();
    loadChedTables();
  } catch (e) {
    state.tablesLoadOk = false;
    setError(`Ошибка загрузки схем (${_remoteLabel(state.currentDb)}): ` + e.message);
  }
}

function onChedSchemaChange(schema) {
  state.chedSchema = schema;
  if (typeof window.__resetSqlSchema === 'function') window.__resetSqlSchema();
  state.tables = []; state.currentTable = ''; state.allRows = [];
  state.filteredRows = []; state.columns = [];
  document.getElementById('tableArea').innerHTML = '';
  document.getElementById('currentTable').textContent = '';
  loadChedTables();
}

async function loadChedTables() {
  const schema = state.chedSchema;
  if (!schema) return;
  const esc = schema.replace(/'/g, "''");
  try {
    const sql =
      "SELECT c.relname AS table_name, COALESCE(d.description,'') AS table_comment " +
      "FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace " +
      "LEFT JOIN pg_description d ON d.objoid=c.oid AND d.objsubid=0 " +
      `WHERE n.nspname='${esc}' AND c.relkind IN ('r','v','m','p','f') ` +
      "ORDER BY c.relname";
    const res = await apiCall(sql, 'preview', 5000);
    if (res && res.ok) {
      state.tables = (res.rows || []).map(r => ({
        name: r.table_name, comment: (r.table_comment || '').trim(),
      }));
      state.tablesLoadOk = true;   // запрос реально прошёл — даже если таблиц 0
      setStatus('ok', `${_remoteLabel(state.currentDb)} · ${schema}: ${state.tables.length} ${plural(state.tables.length, 'таблица', 'таблицы', 'таблиц')}`);
    } else {
      state.tables = [];
      state.tablesLoadOk = false;
      setError((res && res.error) || `Не удалось загрузить таблицы (${_remoteLabel(state.currentDb)})`);
    }
  } catch (e) {
    state.tables = [];
    state.tablesLoadOk = false;
    setError(`Ошибка (${_remoteLabel(state.currentDb)}): ` + e.message);
  }

  const c1 = document.getElementById('tblCountBadge');
  const c2 = document.getElementById('tblCount');
  const lbl = `${state.tables.length} ${plural(state.tables.length, 'таблица', 'таблицы', 'таблиц')}`;
  if (c1) c1.textContent = lbl;
  if (c2) c2.textContent = lbl;
  const list = document.getElementById('tableList');
  if (list) list.dataset.renderedFilter = '__reset__';
  if (typeof renderTableList === 'function') {
    renderTableList(document.getElementById('tableSearch')?.value || '');
  }
}

function _initDbSwitcher() {
  if (!canUseRemote()) return;
  // Кнопка локальной БД — только для админа (остальным её прячем)
  if (!isCurrentUserAdmin()) {
    document.getElementById('dbItemLocal')?.style.setProperty('display', 'none');
  }
  const wrap = document.getElementById('logoWrap');
  const drop = document.getElementById('dbSwitchDropdown');
  if (!wrap || !drop) return;
  wrap.classList.add('admin');
  document.getElementById('logoName')?.addEventListener('click', e => {
    e.stopPropagation();
    drop.style.display = drop.style.display === 'none' ? 'block' : 'none';
  });
  document.addEventListener('click', () => { drop.style.display = 'none'; });
}

async function init() {
  _initDbSwitcher();
  if (_initCalled) return;
  _initCalled = true;

  renderTemplates();
  // Загружаем таблицы в фоне — не блокируем init
  loadTableList();
  // loadOrgList() вызывается лениво в selectTemplate()
  // loadFkRelations() — в фоне после небольшой задержки
  setTimeout(() => loadFkRelations(), 1500);

  // Event listeners для вкладок
  document.getElementById('tab-tables')?.addEventListener('click',    () => switchTab('tables'));
  document.getElementById('tab-templates')?.addEventListener('click', () => switchTab('templates'));
  document.getElementById('tab-saved')?.addEventListener('click',     () => switchTab('saved'));

  // Счётчик таблиц — открывает модальное окно со списком всех таблиц
  document.getElementById('tblCountBadge')?.addEventListener('click', () => openTablesModal());

  // Таблицы modal
  document.getElementById('btnCloseTblModal')?.addEventListener('click',  () => closeTablesModal());
  document.getElementById('btnCloseTblModal2')?.addEventListener('click', () => closeTablesModal());
  document.addEventListener('mousedown', e => {
    const m = document.getElementById('tablesModal');
    if (m?.classList.contains('open') && e.target === m) closeTablesModal();
  });

  // Toolbar
  document.getElementById('btnLoad')?.addEventListener('click',    () => loadTable());
  document.getElementById('btnBack')?.addEventListener('click',    () => goBack());
  document.getElementById('btnReset')?.addEventListener('click',   () => resetFilters());
  document.getElementById('btnCsv')?.addEventListener('click',     () => exportCSV());
  document.getElementById('btnExcel')?.addEventListener('click',   () => exportExcel());
  document.getElementById('btnColumns')?.addEventListener('click', () => toggleColumnsDropdown());
  document.getElementById('limitSelect')?.addEventListener('change', e => onLimitChange(e.target.value));

  // Param panel
  document.getElementById('btnRunTemplate')?.addEventListener('click',   () => runTemplateQuery());
  document.getElementById('btnResetParams')?.addEventListener('click',   () => resetTemplateParams());
  document.getElementById('btnCloseParams')?.addEventListener('click',   () => closeParamPanel());

  // SQL bar
  document.getElementById('sqlToggleBtn')?.addEventListener('click', () => toggleSqlBar());
  document.getElementById('btnRunSql')?.addEventListener('click',    () => runSQL());
  document.getElementById('btnClearSql')?.addEventListener('click',  () => clearSQL());

  // Восстановление SQL после смены вкладки
  const preserved = sessionStorage.getItem('sed_preserved_sql');
  if (preserved) {
    const btn = document.getElementById('btnRestoreSql');
    if (btn) {
      btn.style.display = '';
      btn.addEventListener('click', () => {
        document.getElementById('sqlEditor').value = preserved;
        _sqlManuallyEdited = true;
        autoResizeSQL();
        toggleSqlBar(false);
        btn.style.display = 'none';
        sessionStorage.removeItem('sed_preserved_sql');
        setStatus('ok', 'SQL восстановлен');
      });
    }
  }

  // Export modal
  document.getElementById('btnExportCancel')?.addEventListener('click', () => closeModal());
  document.getElementById('exportConfirmBtn')?.addEventListener('click', () => doExport());

  // FK modal
  document.getElementById('fkBadge')?.addEventListener('click', () => openFkModal());
  document.getElementById('btnCloseFk')?.addEventListener('click', () => closeFkModal());


  // Кнопка Обновить — сбрасывает кэш и перезагружает данные
  document.getElementById('btnClearCache')?.addEventListener('click', async () => {
    const icon = document.getElementById('refreshIcon');
    if (icon) icon.style.transform = 'rotate(360deg)';
    setTimeout(() => { if (icon) icon.style.transform = ''; }, 550);

    // Сбрасываем кэш на сервере
    try {
      await fetch(`${API}?m=System&a=clearCache`, { credentials: 'same-origin' });
    } catch(_) {}

    // Перезагружаем текущие данные
    if (state.selectedTmpl >= 0) {
      runTemplateQuery();
    } else if (state.currentTable) {
      loadTable();
    } else {
      showToast('Кэш сброшен — выберите таблицу или шаблон');
    }
  });

  // Logout
  document.getElementById('btnLogout')?.addEventListener('click', () => doLogout());

  // Поиск таблиц и шаблонов
  document.getElementById('tableSearch')?.addEventListener('input', e => renderTableList(e.target.value));
  document.getElementById('tmplSearch')?.addEventListener('input',  e => renderTemplates(e.target.value));
  document.getElementById('savedSearch')?.addEventListener('input', e => renderSavedList(e.target.value));

  // Первичный рендер сохранённых запросов
  renderSavedList();

  // FK поиск
  document.getElementById('fkSearch')?.addEventListener('input', e => renderFkList(e.target.value));

  // Клиентский фильтр строк
  initFilterInput();

  // Фильтры тулбара 
  ['filterId','filterDateFrom','filterDateTo'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', () => {
      if (state.selectedTmpl >= 0 || !state.currentTable) return;
      _sqlManuallyEdited = false; buildSQL();
    });
  });

  // Кнопка истории запросов
  document.getElementById('btnHistory')?.addEventListener('click', () => openHistoryModal());
  document.getElementById('btnCloseHistory')?.addEventListener('click', () => closeHistoryModal());
  document.getElementById('btnCloseHistory2')?.addEventListener('click', () => closeHistoryModal());
  document.getElementById('btnClearHistory')?.addEventListener('click', () => clearHistory());


  // SQL highlight
  function _escHl(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  function highlightSQL(sql) {
    const hl = document.getElementById('sqlHighlight');
    if (!hl) return;
    hl.innerHTML = _escHl(sql);
    hl.scrollTop = document.getElementById('sqlEditor').scrollTop;
  
  }

  // SQL editor
  const sqlEditor = document.getElementById('sqlEditor');
  if (sqlEditor) {
    sqlEditor.addEventListener('input', () => { _sqlManuallyEdited = true; autoResizeSQL(); highlightSQL(sqlEditor.value); });
    sqlEditor.addEventListener('scroll', () => {
      const hl = document.getElementById('sqlHighlight');
      if (hl) hl.scrollTop = sqlEditor.scrollTop;
    });
    sqlEditor.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        if (state.selectedTmpl >= 0) runTemplateQuery(); else runSQL();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'h') {
        e.preventDefault();
        openHistoryModal();
      }
    });
    autoResizeSQL();
    highlightSQL(sqlEditor.value);
  }
  checkSqlDraft();
}

// ── Регистрация действий шелла для делегирования (V-06) ──────────
// Инлайновые on*-обработчики app_shell.html заменены на data-act;
// функции глобальные, вызываются лениво (к клику все модули загружены).
if (typeof window.sedRegisterActions === 'function') {
  window.sedRegisterActions({
    switchDb:            function (el) { switchDb(el.dataset.db); },
    chedSchema:          function (el) { onChedSchemaChange(el.value); },
    openLocalSqlModal:   function () { openLocalSqlModal(); },
    closeLocalSqlModal:  function () { closeLocalSqlModal(); },
    runLocalSql:         function () { runLocalSql(); },
    cancelQuery:         function () { cancelQuery(); },
    openSaveQueryModal:  function () { openSaveQueryModal(); },
    closeModal:          function () { closeModal(); },
    closeEditSavedModal: function () { closeEditSavedModal(); },
    confirmEditSaved:    function () { confirmEditSaved(); },
    closeSaveQueryModal: function () { closeSaveQueryModal(); },
    confirmSaveQuery:    function () { confirmSaveQuery(); },
  });
}