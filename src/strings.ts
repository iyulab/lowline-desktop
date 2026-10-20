// Every user-facing string lives here, so a change of UI language touches one file.
import type { TemplateProblem } from './documents.js'
import type { Abstention, FieldCurve, TypedReplay } from './projection.js'
/** How a replay did: the share of lookups given a suggestion, the share right, and what to expect next. */
interface Replayed {
  answerRate: number
  precision: number
  promise: number
  promiseAnswered: number
  promiseOver: number
  lookups: number
}

/**
 * What to expect next, when it differs from the whole replay: a replay's precision keeps a time a field did better long
 * after, and the strength was chosen on those very answers, so the promise is the latest stretch's precision lowered to
 * what its answers can vouch for. It is a floor, so it says "at least", with how many answers it rests on beside it.
 */
function promiseTail(replay: Replayed): string {
  if (Math.round(replay.promise * 100) === Math.round(replay.precision * 100)) return ''
  const latest = replay.lookups > replay.promiseOver ? `최근 ${replay.promiseOver.toLocaleString('ko-KR')}건의 ` : ''
  return ` — 앞으로는 적어도 ${Math.round(replay.promise * 100)}% 맞으리라 봅니다(${latest}제안 ${Math.round(replay.promiseAnswered).toLocaleString('ko-KR')}건으로 셈)`
}

export const strings = {
  appName: 'Lowline',
  navLabel: '탐색',
  navTemplates: '서식',
  navDocuments: '문서',
  navTable: '표',
  navLearning: '학습',
  orphanDocuments: '서식 없는 문서',
  toggleSidebar: '사이드바 접기/펼치기',
  shortcuts: '단축키',
  shortcutsClose: '닫기',
  about: '정보',
  aboutVersion: (version: string) => `판 ${version}`,
  aboutCopyright: '© iyulab',
  aboutLicense:
    'Lowline은 GNU Affero General Public License 3.0(AGPL-3.0)으로 배포됩니다. 이 라이선스에 따라 고치고 다시 배포할 수 있으며, 법이 허용하는 한 어떤 보증도 없이 제공됩니다.',
  aboutSource: '소스 코드',
  aboutSourceUrl: 'https://github.com/iyulab/lowline',
  aboutNotices: '함께 쓰는 소프트웨어의 고지',
  aboutNoticesLoading: '읽는 중…',
  aboutNoticesFailed: '고지 파일을 읽지 못했습니다. 설치 폴더의 THIRD-PARTY-NOTICES.txt에 같은 내용이 있습니다.',
  aboutClose: '닫기',
  aboutCheckUpdates: '새 판이 나왔는지 확인하기 — 시작할 때와 하루 한 번',
  aboutOutbound: '이 컴퓨터 밖으로 나가는 것',
  aboutOutboundText: [
    'Lowline은 문서를 이 컴퓨터의 폴더에만 저장합니다. 문서 내용, 칸 값, 파일 이름, 서식 이름, 폴더 경로는 밖으로 보내지 않습니다 — 채팅에서 직접 고른 모델에 보내는 것만 빼고(아래).',
    '채팅을 쓰면, 채팅에 쓴 글과 지금 서식을 채팅에서 고른 모델로 보냅니다. 이 컴퓨터나 직접 적은 주소의 서버를 고르면 그곳으로만 가고, OpenAI·Anthropic·Google·xAI 같은 회사 서비스를 고르면 그 회사로 갑니다. 문서와 칸 값은 보내지 않습니다. 키는 Windows 자격 증명에 저장되고 그 회사 말고는 보내지 않습니다. 채팅을 쓰지 않으면 아무것도 보내지 않습니다.',
    '앱이 오류로 실패하면 고치는 데 필요한 정보만 iyulab에 보냅니다: 실패한 부분과 종류, Lowline 자신의 코드 위치, 앱 판 번호, Windows 판. 이 정보는 Microsoft Azure(한국 중부)에 90일 동안 저장되며, 접속 IP 주소는 저장하지 않습니다. 첫 안정판이 나오기 전까지는 오류 보고를 끌 수 없으며, 안정판부터는 설정에서 끌 수 있습니다.',
    '새 판 확인을 켜 두면 시작할 때와 하루 한 번 GitHub에서 새 판이 있는지 확인합니다. 위에서 끌 수 있습니다.',
  ],
  outboundOnce: '오류가 나면 문서 내용 없이 실패 정보만 iyulab에 보내고, 새 판이 나왔는지 GitHub에서 확인합니다.',
  outboundOnceMore: '자세히',
  outboundOnceOk: '알겠습니다',
  updateAvailable: (version: string) => `새 판 ${version}이 나왔습니다.`,
  updateInstall: '지금 설치',
  updateInstalling: '설치하는 중…',
  updateLater: '나중에',
  updateFailed: '새 판을 설치하지 못했습니다. 나중에 다시 해 보세요.',
  // Each with the key as it is pressed; Ctrl on Windows (⌘ on a Mac does the same).
  shortcutList: [
    { combo: 'Ctrl+S', description: '저장' },
    { combo: 'Ctrl+N', description: '새 문서' },
    { combo: 'Ctrl+F', description: '문서 찾기' },
    { combo: 'Ctrl+Enter', description: '저장하고 다음 미확정 문서' },
    { combo: '↑ ↓ Home End', description: '문서 목록에서 옮겨 가기' },
    { combo: 'Tab · Enter', description: '제안 값으로 가서 받기' },
    { combo: 'Esc', description: '서랍·대화상자 닫기' },
    { combo: 'Ctrl+/', description: '단축키 보기' },
  ],
  openVault: '볼트 열기',
  openVaultTitle: '볼트로 쓸 폴더 선택',
  tagline: '서식을 노트처럼 쓰는 로컬 에디터',
  noVault: '볼트는 서식과 문서를 담는 폴더입니다. 모든 것이 그 폴더의 파일로 남습니다.',
  newVault: '새 볼트 만들기',
  newVaultTitle: '새 볼트로 쓸 빈 폴더 선택',
  newVaultNotEmpty: '빈 폴더를 고르세요. 이미 파일이 있는 폴더는 "기존 폴더 열기"로 엽니다.',
  openFolder: '기존 폴더 열기',
  sampleTemplateName: '문의 접수',
  save: '저장',
  saved: '저장했습니다',
  reloadedOutside: '밖에서 바뀌어 다시 읽었습니다',
  changedOutsideDirty: '이 파일이 밖에서 바뀌었습니다. 저장하면 그 변경을 덮어쓰고, 다시 읽으면 내 편집을 버립니다.',
  readOutside: '밖의 내용으로 다시 읽기',
  unsavedHeading: '저장하지 않은 편집이 있습니다',
  unsavedBody: '지금 편집을 버리면 되돌릴 수 없습니다. 계속 편집해서 저장할 수도 있습니다.',
  unsavedDiscard: '편집 버리기',
  unsavedKeep: '계속 편집',
  removedOutside: '이 파일이 밖에서 지워졌습니다. 저장하면 다시 만듭니다.',
  makeTemplate: '새 서식 만들기',
  newTemplateName: '새 서식',
  noTemplates: '서식이 없습니다. 새 서식을 만드세요.',
  templateSource: '서식 원문',
  preview: '미리보기',
  optionsOf: (label: string) => `${label} 선택지`,
  fieldsTitle: '칸',
  fieldsHelp: '체크한 칸은 판단 칸 — 확정한 문서에서 배워 값을 제안받습니다(서식 앞부분 lowline.suggest에 적힘). 선택지는 쉼표로 나눠 적으면 원문의 그 칸에 그대로 적힙니다 — "값=보이는 이름"으로 적으면 문서에는 값이 저장되고 화면에는 이름이 보여, 이름을 바꿔도 저장된 값과 배운 것이 이어집니다. "이름 바꾸기"는 칸이 보이는 이름(label)만 바꿉니다 — 문서의 값과 배운 것은 칸 이름에 붙어 있어 그대로 이어집니다.',
  fieldsNone: '이 서식에는 칸이 없습니다.',
  templateProblemsTitle: '서식 원문의 문제',
  // Puts a problem's fix into the source, as typing does: one undo takes it away.
  templateFix: '고치기',
  templateProblem: (p: TemplateProblem) =>
    p.kind === 'front-matter'
      ? `서식 앞부분(front matter)을 읽을 수 없어 저장하지 않습니다 — ${p.detail}`
      : p.kind === 'duplicate-field'
        ? `칸 이름 "${p.name}"이(가) 두 번 이상 쓰였습니다${p.lines.length ? `(다시 쓰인 줄: ${p.lines.join(', ')})` : ''}. 문서에는 이 이름으로 값이 하나만 남아 두 칸이 같은 값을 가집니다.`
        : p.kind === 'unknown-condition'
          ? `칸 "${p.field}"의 조건이 이 서식에 없는 칸 "${p.name}"을(를) 가리킵니다. 값이 들어올 수 없어 늘 같게 판정됩니다 — visible-if라면 칸이 계속 숨습니다.`
          : p.kind === 'invalid-condition'
            ? `칸 "${p.field}"의 조건을 읽을 수 없어 조건 없이 늘 보입니다. 조건은 "칸 이름=값" 꼴로 적습니다(예: visible-if="부서=영업").`
          : p.kind === 'unknown-compute'
            ? p.name === p.field
              ? `칸 "${p.field}"의 계산이 자기 자신을 읽습니다. 값이 생기지 않아 늘 비어 있습니다.`
              : `칸 "${p.field}"의 계산이 이 서식에 없는 칸 "${p.name}"을(를) 읽습니다. 값이 들어올 수 없어 늘 비어 있습니다.`
          : p.kind === 'invalid-compute'
            ? `칸 "${p.field}"의 계산을 읽을 수 없어 값이 생기지 않습니다. 계산은 숫자와 칸 이름을 + - * /와 괄호로 잇습니다(예: compute="청구량 * 단가").`
          : p.kind === 'unrecognized-field'
            ? `${p.line ? `${p.line}번째 줄은 ` : ''}칸 "${p.name}"처럼 보이지만 칸으로 읽히지 않아 글자로 보입니다. ${
                p.fix ? `이렇게 쓰면 칸이 됩니다: ${p.fix.text}` : `칸은 "@이름: [형식]"으로 씁니다 — 형식과 속성은 대괄호 안에(예: @${p.name}: [text]).`
              }`
          : p.kind === 'shared-id'
            ? `다른 서식 파일(${p.names.join(', ')})도 id "${p.id}"를 씁니다. 판이 달라도 같은 서식이라 볼트는 판이 높은 파일을 서식으로 읽고, 다른 파일은 서식으로 쓰지 않습니다 — 판은 파일 하나 안에서 올리세요.`
          : p.kind === 'unknown-reference'
            ? `칸 "${p.field}"이(가) 가리키는 서식 "${p.target}"이(가) 볼트에 없습니다. 고를 문서가 없어, 그 서식(id: ${p.target})이 생길 때까지 값은 적힌 그대로 둡니다.`
          : p.kind === 'many-to-many'
            ? `칸 "${p.field}"의 "<-> ${p.target}"(여러 문서를 가리킴)은 아직 읽지 않습니다 — 이 칸은 적힌 타입 그대로 쓰입니다. 한 문서를 가리키려면 "->"를 쓰세요.`
          : p.kind === 'stray-values'
            ? `문서 ${p.count}건에 칸 "${p.name}"의 값이 있는데 이 서식에는 그 칸이 없습니다. 값은 파일에 남지만 표와 제안에서 빠집니다 — 보이는 이름만 바꾸려면 칸 이름은 두고 칸 목록의 "이름 바꾸기"를 쓰세요.`
            : `lowline.suggest의 "${p.name}"은(는) 이 서식의 칸이 아니라 제안이 켜지지 않습니다.`,
  judgmentFields: (labels: string[]) => `제안 받는 칸: ${labels.join(', ')}`,
  // `cases`: the document has "비슷한 사례" below, where the person can look at other documents' values themselves.
  judgmentAbstained: (reason: Abstention | null | undefined, learned: number, cases = false) =>
    reason === 'no-history' || (!reason && learned === 0)
      ? `확정한 문서가 아직 없어 제안하지 않습니다. 저장할 때마다 배웁니다.`
      : (reason === 'undecided'
          ? `지금 입력한 값들로는 함께 확정된 값이 정해지지 않아 비워 둡니다.`
          : `확정한 ${learned}건으로는 함께 확정된 값이 목표만큼 맞는다는 것을 아직 보이지 못해 제안하지 않습니다.`) +
        (cases ? ` 아래 '비슷한 사례'에서 다른 문서가 확정한 값을 볼 수 있습니다.` : ''),
  // Asked after each pause in typing, so the next pause asks again.
  judgmentUnavailable: '이 칸의 제안을 준비하지 못했습니다 — 입력을 이어 가면 다시 묻습니다.',
  // The sidecar did not start: filling in and saving do not need it.
  suggestionsUnavailable: '제안을 준비하지 못했습니다. 입력과 저장은 그대로 됩니다 — 앱을 다시 열면 다시 시도합니다.',
  newDocument: '새 문서',
  noDocuments: '문서가 없습니다.',
  documentsFilter: '이름이나 칸 값으로 찾기',
  documentsUnsettledOnly: (count: number) => `미확정만 (${count})`,
  saveAndNext: '저장하고 다음',
  noMoreUnsettled: '저장했습니다. 판단 칸이 빈 문서가 더 없습니다.',
  documentsNoMatch: '이름이나 칸 값이 맞는 문서가 없습니다.',
  /** While the sidecar looks through the documents' values (the first index of a large vault takes a while). */
  documentsSearching: '칸 값에서 찾는 중…',
  documentsSearchFailed: '칸 값에서는 찾지 못해 이름으로만 찾았습니다.',
  similarCases: '비슷한 사례',
  similarLoading: '찾는 중…',
  similarNone: '이 서식에 비슷한 문서가 없습니다.',
  /** Under a similar document: what it confirmed in the judgment fields — evidence to read, not a suggestion. */
  similarJudged: (judged: { label: string; value: string }[]) => `확정: ${judged.map((j) => `${j.label} ${j.value}`).join(' · ')}`,
  similarFailed: '비슷한 문서를 찾지 못했습니다. 다시 펼치면 다시 찾습니다.',
  conflictCopyOf: (original: string) => `충돌 사본 — 원본: ${original}`,
  hasConflictCopy: '충돌 사본 있음',
  conflictedOriginal: '다른 기기에서 고친 사본이 있습니다. 하나로 정할 때까지 제안이 이 문서에서 배우지 않습니다. 사본을 열어 남길 쪽을 고르세요.',
  conflictCopy: (original: string) =>
    `동기화 도구가 남긴 충돌 사본입니다(원본: ${original}). 이 사본을 남기면 원본은 휴지통으로 가고 이 사본이 원본 이름을 받습니다. 원본을 남기려면 이 사본을 지우세요.`,
  conflictedTemplate: '다른 기기에서 고친 사본이 있습니다. 사본을 열어 남길 쪽을 고르세요.',
  viewCopy: (name?: string) => (name === undefined ? '사본 보기' : `사본 보기: ${name}`),
  keepCopy: '이 사본을 남기기',
  keepCopyHeading: '이 사본을 남길까요?',
  keepCopyBody: (original: string) =>
    `원본(${original})을 휴지통으로 옮기고, 이 사본이 그 이름을 받습니다. 휴지통에서 원본을 되살릴 수 있습니다.`,
  keepCopyConfirm: '사본 남기기',
  keepCopyNotTrashedBody: '이 위치에는 휴지통이 없을 수 있습니다. 두 파일 모두 그대로 있습니다. 원본을 영구히 지우면 되살릴 수 없습니다.',
  keepCopyPermanently: '원본 영구히 지우기',
  keptCopy: (permanently: boolean) => (permanently ? '사본을 남겼습니다. 원본은 지웠습니다.' : '사본을 남겼습니다. 원본은 휴지통에 있습니다.'),
  keptCopyNameTaken: (permanently: boolean) =>
    `원본 이름의 파일이 다시 생겨 이 사본에 그 이름을 줄 수 없습니다. ${permanently ? '원본은 지웠고' : '원본은 휴지통에 있고'} 이 사본은 그대로입니다.`,
  keptOriginal: (permanently: boolean) => (permanently ? '사본을 지우고 원본을 남겼습니다.' : '사본을 휴지통으로 옮기고 원본을 남겼습니다.'),
  documentFrom: (name: string) => `서식: ${name}`,
  cancel: '취소',
  rename: '이름 바꾸기',
  renameConfirm: '바꾸기',
  newName: '새 이름',
  renamed: '이름을 바꿨습니다',
  delete: '지우기',
  deleteConfirm: '휴지통으로 옮기기',
  deleteDocumentHeading: '이 문서를 지울까요?',
  deleteDocumentBody: (unsaved: boolean) =>
    `파일을 휴지통으로 옮깁니다. 휴지통에서 되살릴 수 있습니다. 이 문서의 확정 값은 더 이상 제안에 쓰이지 않습니다.${unsaved ? ' 저장하지 않은 편집은 함께 사라집니다.' : ''}`,
  deleteTemplateHeading: '이 서식을 지울까요?',
  deleteTemplateBody: (unsaved: boolean) =>
    `파일을 휴지통으로 옮깁니다. 휴지통에서 되살릴 수 있습니다. 이 서식으로 쓴 문서는 지우지 않습니다 — "서식 없는 문서"에 남습니다.${unsaved ? ' 저장하지 않은 편집은 함께 사라집니다.' : ''}`,
  deleteCopyHeading: '이 사본을 지울까요?',
  deleteCopyBody: (unsaved: boolean) =>
    `사본을 휴지통으로 옮기고 원본을 남깁니다. 휴지통에서 되살릴 수 있습니다.${unsaved ? ' 저장하지 않은 편집은 함께 사라집니다.' : ''}`,
  notTrashedHeading: '휴지통으로 옮기지 못했습니다',
  notTrashedBody: '이 위치에는 휴지통이 없을 수 있습니다. 파일은 그대로 있습니다. 영구히 지우면 되살릴 수 없습니다.',
  deletePermanently: '영구히 지우기',
  trashed: '휴지통으로 옮겼습니다',
  removed: '지웠습니다',
  templateDeleted: (permanently: boolean, orphans: boolean) =>
    `${permanently ? '서식을 지웠습니다.' : '서식을 휴지통으로 옮겼습니다.'} 그 서식으로 쓴 문서는 지우지 않았습니다${orphans ? ' — "서식 없는 문서"에 있습니다' : ''}.`,
  linkNotFollowed: (address: string) =>
    `링크는 Lowline 창에서 열지 않습니다. 쓰던 내용은 그대로입니다. 브라우저에서 보려면 주소를 복사해 여세요: ${address}`,
  linkNotWeb: (address: string) => `웹 주소와 메일 링크만 엽니다. 쓰던 내용은 그대로입니다. 주소: ${address}`,
  linkOpened: (address: string) => `브라우저에서 열었습니다: ${address}`,
  linkNotOpened: (address: string) => `링크를 열지 못했습니다. 쓰던 내용은 그대로입니다. 주소를 복사해 여세요: ${address}`,
  nameTaken: '같은 이름의 문서가 이미 있습니다.',
  templateNameTaken: '같은 이름의 서식이 이미 있습니다.',
  nameInvalid: '이름이 비었거나 파일 이름에 쓸 수 없는 글자(\\ / :* ? " < > |)가 있습니다.',
  import: '가져오기',
  importTitle: '기존 기록 가져오기',
  importPaste: '복사한 행을 여기에 붙여 넣으세요',
  importHint: '스프레드시트에서 첫 행(칸 이름)부터 기록 행까지 복사합니다. 칸 이름이 서식의 칸과 같은 열만 가져옵니다.',
  importColumn: '붙여 넣은 열',
  importField: '채울 칸',
  importUnmatched: '가져오지 않음',
  importUseDate: '기록한 날짜 — 파일 이름의 날짜',
  importUseName: '번호 — 파일 이름 앞에',
  importUseOf: (heading: string) => `${heading} 열을 어디에 쓸지`,
  importSummary: (documents: number, skipped: number) =>
    skipped ? `문서 ${documents}건을 만듭니다 · 빈 행 ${skipped}개는 건너뜁니다` : `문서 ${documents}건을 만듭니다`,
  importProblems: (n: number) => `칸에 맞지 않는 값 ${n}개 — 적힌 그대로 가져옵니다`,
  importProblem: (row: number, field: string, value: string, reason?: 'reference') =>
    `${row}행 ${field}: ${value}${reason === 'reference' ? ' — 이 이름의 문서가 없거나 둘 이상입니다' : ''}`,
  importConfirm: (n: number) => `${n}건 가져오기`,
  importing: (done: number, total: number) => `가져오는 중 ${done} / ${total}`,
  imported: (n: number) => `${n}건을 가져왔습니다`,
  importStopped: (created: number, message: string) => `${created}건을 만든 뒤 멈췄습니다: ${message}`,
  importTextTitle: '표가 아닌 글에서',
  importTextHint: (limit: number) =>
    `메일·메모·문서에서 복사한 기록을 붙여 넣으면, 채팅의 모델이 조금씩 나눠 서식의 칸 값으로 읽습니다. 한 번에 ${limit.toLocaleString('ko-KR')}자까지 — 그래픽 카드 없이 이 컴퓨터에서 돌리면 몇 분 걸릴 수 있습니다.`,
  importTextNoModel: '서식 화면의 채팅에서 모델을 정하면, 표가 아닌 글에서도 기록을 읽어 가져올 수 있습니다.',
  importTextLabel: '붙여 넣은 글',
  importTextRead: '모델로 읽기',
  importTextReading: (done: number, of: number, found: number) => `모델이 읽는 중… ${done} / ${of} 조각 · 기록 ${found}건`,
  importTextStop: '여기까지만 읽기',
  importTextPartial: (done: number, of: number) => `${of}조각 중 ${done}조각까지 읽은 기록입니다. 나머지는 가져오지 않습니다.`,
  importTextCount: (n: number, limit: number) => `${n.toLocaleString('ko-KR')} / ${limit.toLocaleString('ko-KR')}자`,
  importTextUnread: '모델의 답에서 기록을 읽지 못했습니다. 다시 읽거나, 글을 줄여 보세요.',
  importTextNone: '글에서 기록을 찾지 못했습니다.',
  importTextFailed: (why: string) => `모델이 읽지 못했습니다: ${why}`,
  importRecords: '모델이 읽은 기록',
  importProposedBy: (model: string) => `채팅(${model})`,
  importProposedNote: (by: string) =>
    `*는 판단 칸입니다. 그 값은 ${by}의 제안으로 들어가고, 문서마다 사람이 정하기 전에는 배우지 않습니다. 다른 칸의 값은 가져오는 대로 문서의 값이 됩니다.`,
  tableExport: 'CSV로 내보내기',
  tableExportDocument: '문서',
  tableExportFilter: 'CSV (쉼표로 구분)',
  tableExported: (file: string) => `${file}(으)로 내보냈습니다`,
  tableEmpty: '이 서식으로 만든 문서가 없습니다.',
  tableCount: (n: number) => `문서 ${n}건`,
  tableMatching: (n: number) => `조건에 맞는 문서 ${n}건`,
  tableNoMatch: '조건에 맞는 문서가 없습니다.',
  tableFilters: '표 거르기',
  tableFilterName: '이름에 든 글자',
  tableFilterAny: (label: string) => `${label}: 모두`,
  tableFilterEmpty: (label: string) => `${label}: 비어 있음`,
  tableFilterField: '글자를 찾을 칸',
  tableFilterText: '칸에 든 글자',
  tableFilterAtLeast: (label: string) => `${label} 이상`,
  tableFilterAtMost: (label: string) => `${label} 이하`,
  backToList: '목록으로',
  navReferences: '기준',
  referringTitle: '이 문서를 가리키는 문서',
  referringNone: '아직 없습니다.',
  referringGroup: (template: string, n: number) => `${template} ${n}건`,
  referringName: '이름',
  // A new document of that template, naming the one open here: a row added under it.
  referringAdd: (template: string) => `새 ${template}`,
  // A reference field's value naming a document the vault does not have: kept, shown by the start of its id.
  missingReference: (template: string, id: string) => `없는 ${template} (${id.slice(0, 8)})`,
  tableSkipped: (n: number) => `표에 넣지 못한 문서 ${n}건`,
  tableFilterFrom: (label: string) => `${label} 부터`,
  tableFilterUntil: (label: string) => `${label} 까지`,
  tableSkippedFields: (n: number) => `값을 읽지 못해 비운 칸 ${n}개`,
  /** Before a value a date or number field could not take, shown beside it — the file keeps it. */
  unreadValue: '파일에 적힌 값:',
  tableSkippedField: (document: string, field: string) => `${document} — ${field}`,
  hostStarting: '표를 준비하고 있습니다…',
  learningEmpty: '제안을 받는 판단 칸이 아직 없습니다. 서식에서 판단 칸을 정하면 여기서 곡선이 자랍니다.',
  learningOutside: (form: string, outside: number, confirmed: number) =>
    `${form}: 판단 칸이 채워진 문서 ${confirmed}건 가운데 ${outside}건은 Lowline에서 저장한 적이 없습니다. 다른 프로그램이 쓴 값이라 사람이 확정했는지 알 수 없지만, 제안은 이 값에서도 배웁니다.`,
  learningUndecided: '아직 결정된 제안이 없습니다 — 제안을 수락·교정·거절하며 저장하면 곡선이 자랍니다.',
  // What a field needs for a suggestion: another field whose value the documents settled it alongside.
  learningWhatSuggests: '제안은 다른 칸에 같은 값이 든 문서들이 이 칸을 목표만큼 자주 같게 확정해 왔을 때 나옵니다 — 이 칸을 가르는 칸이 서식에 있는지 보세요.',
  learningNoReplay: (why: FieldCurve['whyNoReplay'], closest?: FieldCurve['closest']) =>
    why === 'few'
      ? '기록이 아직 적어 다시 물어보지 않았습니다 — 확정한 문서가 늘면 저장된 기록을 순서대로 다시 물어 제안 기준을 고릅니다.'
      : why === 'below-target' && closest
        ? closest.precision >= closest.target
          ? `저장된 기록을 순서대로 다시 물으면 가장 정확한 기준에서 ${closest.answered}건 중 ${Math.round(closest.precision * 100)}%를 맞혀 합쳐서는 목표 ${Math.round(closest.target * 100)}%에 닿지만, 그 안의 한 구간이 목표에 못 미쳐 이 칸은 아직 제안하지 않습니다. ${strings.learningWhatSuggests}`
          : `저장된 기록을 순서대로 다시 물으면 가장 정확한 기준에서도 ${closest.answered}건 중 ${Math.round(closest.precision * 100)}%만 맞혀 목표 ${Math.round(closest.target * 100)}%에 못 미칩니다 — 이 칸은 아직 제안하지 않습니다. ${strings.learningWhatSuggests}`
      : why === 'below-target'
        ? '저장된 기록을 순서대로 다시 물어도 목표만큼 맞히는 기준이 없어, 이 칸은 아직 제안하지 않습니다. ' + strings.learningWhatSuggests
        : '저장된 기록을 순서대로 다시 물어 제안 기준을 고르는 중입니다 — 끝나면 여기에 나타납니다.',
  // Shown after what the field's replay said before, while one over its grown history chooses again.
  learningRechoosing: '(기록이 늘어 다시 고르는 중 — 끝나면 바뀝니다)',
  learningSimilarOnly: '함께 확정된 값으로는 저장된 기록을 순서대로 다시 물어도 목표만큼 맞히는 기준이 없습니다 — 이 칸은 아래의 비슷한 기록으로만 제안합니다.',
  learningTitle: (template: string, field: string) => `${template} · ${field}`,
  // Counted over fields that got a suggestion; a field the memory left blank is not in it.
  learningRate: (rate: number, of: number) => `제안이 나온 최근 ${of}건 중 맞음 ${Math.round(rate * 100)}%`,
  // Before the window is full a share reads as more than it is: one right answer is not "100%".
  learningFew: (right: number, of: number) => `제안이 나온 ${of}건 중 ${right}건 맞음 — 아직 비율을 말하기엔 적습니다`,
  learningFirst: (rate: number, of: number) => `처음 ${of}건 ${Math.round(rate * 100)}%`,
  learningCounts: (accepted: number, corrected: number, rejected: number) => `수락 ${accepted} · 교정 ${corrected} · 거절 ${rejected}`,
  // Each source of suggestions read apart — a share only once there are enough decisions to say one.
  learningBySource: (source: string, decided: number, accepted: number) =>
    `${source === 'key' ? '함께 확정된 값' : source === 'memory' ? '비슷한 기록' : source === 'proposed' ? '다른 프로그램' : source === 'coarse' ? '앞부분(분류)' : source}에서 낸 제안 ${decided}건 중 ${accepted}건 수락${
      decided >= 10 ? ` (${Math.round((accepted / decided) * 100)}%)` : ''
    }`,
  // The replay also counts the fields memory left blank, which the curve does not.
  learningReplay: (replay: Replayed) =>
    `저장된 ${replay.lookups}건을 순서대로 다시 물으면 ${Math.round(replay.answerRate * 100)}%에 제안, 그중 ${Math.round(replay.precision * 100)}% 맞음` +
    promiseTail(replay),
  learningClass: (replay: Replayed) =>
    `앞부분(분류): 값을 제안하지 못한 ${replay.lookups}건 중 ${Math.round(replay.answerRate * 100)}%에 분류를 제안, 그중 ${Math.round(replay.precision * 100)}% 맞음` +
    promiseTail(replay),
  // Similar records answer where values settled alongside did not — offered only once their promise rests on enough answers.
  learningSimilar: (replay: Replayed & { offered: boolean; offeredFrom: number }) =>
    `비슷한 기록: 함께 확정된 값이 제안하지 못한 ${replay.lookups}건 중 ${Math.round(replay.answerRate * 100)}%에 제안, 그중 ${Math.round(replay.precision * 100)}% 맞음` +
    (replay.offered
      ? promiseTail(replay)
      : ` — 약속이 기댄 제안이 ${Math.round(replay.promiseAnswered)}건으로 ${replay.offeredFrom}건이 안 되어, 비슷한 기록에서는 아직 제안하지 않습니다.`),
  learningTyping: (typing: TypedReplay[]) =>
    typing.length === 0
      ? '칠 때: 앞 제안이 맞지 않은 기록을 앞에서부터 쳐 보아도 아직 목표만큼 맞히는 글자 수가 없어, 치는 동안에도 제안하지 않습니다.'
      : `칠 때: 앞 제안이 맞지 않은 기록을 앞에서부터 쳐 보면 ${typing
          .map((t) => `${t.characters}글자 뒤 ${t.lookups}건 중 ${Math.round(t.answerRate * 100)}%에 제안, 그중 ${Math.round(t.precision * 100)}% 맞음`)
          .join(' · ')} — 이 칸은 치는 글자로 시작하는 값만 제안합니다.`,
  learningDependsOn: (fields: string[]) =>
    `제안은 ${fields.join(' · ')} 칸의 값에 기댑니다 — 다시 물어 보니 이 칸만 볼 때 같은 정확도로 더 자주 제안했습니다`,
  learningChart: (field: string) => `${field} — 제안이 나온 칸 중 맞은 비율, 결정 순서대로`,
  learningPoint: (n: number, rate: number) => `${n}번째 결정 뒤 ${Math.round(rate * 100)}%`,
  learningTable: '표로 보기',
  countsTitle: '주별 집계 (개수만)',
  countsHelp:
    '제안이 나아지는지 연구하는 쪽에 직접 건넬 수 있는 집계입니다. 서식과 칸은 번호로만 적고, 문서 내용·값·이름·경로는 담지 않습니다. 보인 제안 수(presented)는 이 기기에서 보인 것만, 결정은 볼트를 함께 쓰는 모든 기기의 것을 셉니다.',
  countsForm: (n: number, name: string, fields: string[]) => `서식 ${n} = ${name} (칸 ${fields.map((f, i) => `${i + 1} = ${f}`).join(', ')}) — 이 대응은 복사되지 않습니다`,
  countsCopy: '집계 복사',
  countsCopied: '복사했습니다',
  countsCopyFailed: '복사하지 못했습니다. 위 글을 선택해 복사하세요.',
  learningN: '결정',
  learningAt: '시각',
  learningShare: '제안이 나온 칸 중 맞은 비율',
  suggestion: '제안',
  writtenWith: (version: string, now: string) => `이 문서는 서식 ${version}판으로 쓰였습니다(지금 ${now}판). 값과 배운 것은 이 서식의 것으로 이어집니다 — 본문도 지금 판으로 옮길 수 있습니다.`,
  reviseDocument: '지금 판으로 옮기기',
  revised: '지금 판으로 옮겼습니다',
  suggestionKey: (value: string) => `제안 · 함께 확정된 값: ${value}`,
  // A value a similar record confirmed, where none settled alongside answered: the record, by its name, is the evidence.
  suggestionSimilar: (record: string) => `제안 · 비슷한 기록에서: ${record}`,
  // A class, not the value: its first characters, for the person to type the rest after.
  suggestionClass: (source: string) => `${source} · 값의 앞부분(분류)만 — 고르면 이어서 칩니다`,
  // A value another program wrote into the document as a suggestion: who wrote it, as the file names them.
  suggestionProposed: (by: string) => `제안 · ${by || '다른 프로그램'}에서 넣은 값`,
  // In the table: a value another program wrote as a suggestion, not yet decided by a person.
  tableProposed: (value: string) => `${value} (제안)`,
  reject: '거절',
  hostFailed: (message: string) => `표를 만드는 도우미가 시작되지 않았습니다: ${message}`,
  errors: {
    'missing-id': '서식 front matter에 id가 없습니다.',
    'missing-version': '서식 front matter에 version이 없습니다.',
    'invalid-id': '서식 id에는 공백과 @를 쓸 수 없습니다.',
    'reserved-field': '칸 이름으로 template과 lowline은 쓸 수 없습니다. 문서가 이 이름을 스스로 씁니다.',
    'template-not-found': (ref: string) => `이 문서의 서식(${ref})을 볼트에서 찾지 못했습니다.`,
    'already-exists': '같은 이름의 파일이 이미 있습니다.',
    unknown: (message: string) => `작업을 끝내지 못했습니다: ${message}`,
  },
  chat: '채팅',
  chatClose: '채팅 닫기',
  chatModelChange: '모델 바꾸기',
  chatFromFile: '빈 서식 파일에서',
  chatFromFileTitle: '빈 서식 파일 고르기',
  chatFromFileKinds: '한글·PDF 서식',
  chatFromFileAsk: (name: string) => `빈 서식 «${name}»으로 이 서식을 만들어 주세요.`,
  chatFromFileFailed: (name: string, failure: string | null) =>
    `«${name}»을 읽지 못했습니다. ${
      failure === 'unsupported'
        ? '한글(HWP·HWPX)과 PDF 서식만 읽습니다.'
        : failure === 'empty'
          ? '파일에 글이 없습니다 — 스캔한 서식은 글로 읽지 못합니다.'
          : failure === 'too-long'
            ? '빈 서식으로 보기엔 글이 너무 깁니다.'
            : '파일이 열리지 않거나 손상되었습니다.'
    }`,
  chatPlaceholder: '서식을 어떻게 바꿀지 말해 보세요',
  chatEmpty:
    '이 채팅은 생성형 AI 모델이 답합니다. 칸을 넣거나 빼거나 고치는 것을 말로 부탁하면, 바뀐 서식을 편집기에 넣습니다. 종이 서식이 있으면 «빈 서식 파일에서»로 그 한글(HWP)·PDF 파일에서 시작할 수 있습니다. 쓴 것은 초안이고, 저장은 직접 합니다.',
  chatYou: '나',
  chatWriting: '쓰는 중…',
  chatStopped: '멈췄습니다.',
  chatRetry: '이 초안은 서식으로 쓸 수 없는 곳이 있습니다. 고친 서식 전체를 다시 보내 주세요.',
  chatDraftPut: (added: string[], removed: string[]) =>
    [
      '바뀐 서식을 편집기에 넣었습니다.',
      added.length ? `넣은 칸: ${added.join(', ')}.` : '',
      removed.length ? `뺀 칸: ${removed.join(', ')}.` : '',
      '확인하고 저장하세요.',
    ]
      .filter(Boolean)
      .join(' '),
  chatDraftProblems: '고친 뒤에도 남은 문제가 있습니다 — 편집기 위 목록을 보세요.',
  // A template for one of the draft's repeated rows, whose documents point at this template's: the person makes it.
  chatRowDrafted: (title: string) => `되풀이되는 줄을 서식 «${title}»로 따로 썼습니다 — 줄마다 그 서식의 문서가 되고, 이 서식의 문서 화면에 표로 보입니다.`,
  chatRowMake: (title: string) => `«${title}» 서식 만들기`,
  chatRowMade: (title: string) => `서식 «${title}»을 만들었습니다 — 사이드바에서 엽니다.`,
  chatRowProblem: (title: string, problem: string) => `줄 서식 «${title}»: ${problem}`,
  // Asking again: a row of a table spread over numbered fields instead of a template of its own.
  chatRowsSpread: (shape: string) =>
    `칸 «${shape}»(N = 1, 2, 3…)처럼 같은 줄을 번호로 펼쳤습니다. 그 한 줄을 서식 하나로 따로 써서 두 번째 formdown 블록에 담고(새 id, 맨 앞 칸은 이 서식의 문서를 가리키는 칸), 이 서식에서는 그 칸들을 빼 주세요.`,
  chatRowsSpreadLeft: '같은 줄을 번호로 펼친 칸이 남았습니다 — 줄마다 문서가 되게 하려면 «줄은 서식 하나로 따로»라고 다시 부탁해 보세요.',
  chatRowSaveFirst: '이 서식을 먼저 저장하세요 — 줄 서식이 가리킬 서식이 볼트에 있어야 줄이 이어집니다.',
  chatRowReversed:(title: string, parent: string) =>
    `이 서식이 줄 서식 «${title}»의 문서를 가리킵니다 — 거꾸로입니다. 이 서식에서 그 칸을 빼고, 줄 서식 맨 앞에 \`@이름 -> ${parent}: [select]\` 칸을 넣어 줄이 이 서식의 문서를 가리키게 해 주세요.`,
  chatRowSameId: '줄 서식의 id가 이 서식과 같습니다 — 다른 id를 써야 합니다.',
  chatRowNoParent: (parent: string) =>
    `이 서식(${parent})의 문서를 가리키는 칸이 없습니다 — 맨 앞에 \`@이름 -> ${parent}: [select]\` 칸을 넣어야 줄이 이 서식의 문서에 이어집니다.`,
  chatUndo: '넣기 전으로',
  chatFailed: (why: string) => `답을 받지 못했습니다. ${why}`,
  chatModes: '채팅이 할 일',
  chatModeAuthor: '서식 고치기',
  chatModeAsk: '기록에 묻기',
  chatAskPlaceholder: '이 서식의 기록에 물어보세요',
  chatAskEmpty:
    '이 채팅은 생성형 AI 모델이 답합니다. 모델은 질문을 「무엇을 셀지」로 바꾸기만 하고, 세는 일은 Lowline이 볼트의 기록으로 합니다 — 기록의 값은 모델에 가지 않습니다. 줄마다 그 수를 이루는 문서를 열 수 있습니다.',
  queryCounted: (words: string) => `센 것: ${words}`,
  queryTotal: (n: number) => `모두 ${n}건`,
  queryNone: '맞는 기록이 없습니다.',
  queryCount: '건수',
  queryEvidence: '문서',
  queryBlank: '(비어 있음)',
  queryMore: (n: number) => `외 ${n}건`,
  queryUnanswerable: (why: string) => `이 서식의 칸으로는 셀 수 없습니다 — ${why}`,
  queryNoPlan: '무엇을 셀지 알아듣지 못했습니다. 서식의 칸 이름을 넣어 다시 물어보세요.',
  queryUnknownField: (field: string) => `서식에 없는 칸(${field})으로 세려 했습니다. 칸 이름을 넣어 다시 물어보세요.`,
  queryBadFilter: (field: string) => `${field} 칸에 걸 수 없는 조건이었습니다. 다르게 물어보세요.`,
  queryNotSaved: '이 서식이 아직 저장되지 않아 셀 기록이 없습니다.',
  queryAll: '모든 기록',
  queryAllOf: (template: string) => `「${template}」의 모든 기록`,
  queryOf: (template: string) => `「${template}」 기록 중`,
  queryUnknownTemplate: (template: string) => `이 서식을 가리키지 않는 서식(${template})의 기록을 세려 했습니다. 다르게 물어보세요.`,
  queryEqual: (field: string, value: string) => `${field} = ${value}`,
  queryContains: (field: string, words: string) => `${field}에 「${words}」 포함`,
  queryEmpty: (field: string) => `${field} 비어 있음`,
  queryBounds: (field: string, from: string | undefined, to: string | undefined, dated: boolean) =>
    from !== undefined && to !== undefined
      ? `${field} ${from} ~ ${to}`
      : from !== undefined
        ? `${field} ${from}${dated ? '부터' : ' 이상'}`
        : `${field} ${to}${dated ? '까지' : ' 이하'}`,
  queryBy: (fields: string[]) => `${fields.join('·')}별`,
  queryTop: (n: number) => `많은 것 ${n}개`,
  queryTopSum: (n: number) => `합계가 큰 것 ${n}개`,
  querySumOf: (field: string) => `${field} 합계`,
  querySumTotal: (field: string, total: string) => `${field} 합계 ${total}`,
  querySumNone: (field: string) => `${field}에 값이 있는 기록이 없습니다`,
  querySumCounted: (counted: number, count: number) => `(${count}건 중 ${counted}건에 값)`,
  modelTitle: '채팅이 쓸 모델',
  modelHelp: '이 컴퓨터나 가까운 서버에서 돌리는 모델, 또는 키를 가진 서비스를 고릅니다. 채팅을 쓰지 않으면 아무것도 고르지 않아도 됩니다.',
  modelPreset: '어디에 있는 모델인가요',
  modelPresetLocal: '이 컴퓨터에서(Lowline이 받아 돌림)',
  modelLocalShort: '이 컴퓨터',
  modelPresetOllama: '내 컴퓨터의 Ollama',
  modelPresetGpustack: 'GPUStack 서버',
  modelPresetCustom: '다른 주소(OpenAI 호환)',
  modelAddress: '주소',
  modelAddressOptional: '주소(비우면 이 컴퓨터)',
  modelKey: '키',
  modelKeyOptional: '키(있으면)',
  modelKeyKept: '저장된 키를 씁니다',
  modelKeyKeptNote: '키는 Windows 자격 증명에 저장돼 있습니다.',
  modelKeyForget: '키 지우기',
  modelGoesOutside: (company: string) => `채팅에 보낸 글과 지금 서식은 ${company}로 갑니다.`,
  modelStaysAtAddress: '채팅에 보낸 글과 지금 서식은 이 주소의 서버로만 갑니다.',
  modelStaysHere: '채팅에 보낸 글과 지금 서식은 이 컴퓨터 밖으로 나가지 않습니다.',
  modelLocalFetch:
    '처음 준비할 때 모델 파일을 Hugging Face에서, 그것을 돌리는 프로그램(llama.cpp)을 GitHub에서 받습니다. 받을 때 보내는 것은 받을 파일의 요청뿐입니다.',
  modelLocalChoose: '모델',
  modelLocalOption: (name: string, gigabytes: string, here: boolean, recommended: boolean) =>
    `${name} · ${gigabytes} GB${here ? ' · 받아 둠' : ''}${recommended ? ' · 권장' : ''}`,
  modelLocalPrepare: (here: boolean) => (here ? '준비하기' : '받고 준비하기'),
  modelLocalGetting: (what: 'model' | 'runtime', received: string, total: string) =>
    `${what === 'model' ? '모델' : '실행 프로그램'}을 받는 중 ${received} / ${total} GB`,
  modelLocalGettingSize: (what: 'model' | 'runtime') => `${what === 'model' ? '모델' : '실행 프로그램'}을 받는 중…`,
  modelLocalStarting: '모델을 켜는 중… 처음에는 1분쯤 걸릴 수 있습니다.',
  modelLocalReady: '준비됐습니다.',
  modelLocalListFailed: '이 컴퓨터의 모델 목록을 읽지 못했습니다.',
  modelCheck: '연결 확인',
  modelChecking: '확인하는 중…',
  modelCheckFailed: '연결을 확인하지 못했습니다.',
  modelAnswered: (count: number) => (count > 0 ? `연결됐습니다. 모델 ${count}개` : '연결됐지만 고를 모델이 없습니다.'),
  modelChoose: '모델',
  modelSave: '이 모델로 쓰기',
  modelStopUsing: '모델 쓰지 않기',
  modelFailureInvalid: '이 값으로는 연결할 수 없습니다. 주소와 키를 확인하세요.',
  modelFailureUnauthorized: '키가 거절됐습니다. 키를 다시 확인하세요.',
  modelFailureHttpStatus: (status: number | null) =>
    `서버가 오류로 답했습니다${status ? `(HTTP ${status})` : ''}. 주소의 경로와 모델 이름을 확인하세요.`,
  modelFailureTimeout: '시간 안에 답이 없습니다.',
  modelFailureRefused: '그 주소에서 듣고 있는 서버가 없습니다. 서버가 켜져 있는지 확인하세요.',
  modelFailureHostNotFound: '주소의 컴퓨터 이름을 찾지 못했습니다.',
  modelFailureUnreachable: '네트워크나 그 컴퓨터에 닿지 못했습니다.',
  modelFailureTransport: '연결하는 도중에 실패했습니다.',
  modelFailureNotDownloaded: '이 컴퓨터에 그 모델이 없습니다. 모델 설정에서 다시 받아 주세요.',
  modelFailureNotStarted: '모델을 켜지 못했습니다. 메모리가 모자라거나 파일이 손상됐을 수 있습니다.',
} as const

/**
 * A starter template: its front matter names it, the body is plain Formdown. Field names are
 * Korean so the labels and the document's front matter keys read in the UI's language.
 */
/**
 * The sample a new vault starts with: an intake form with one judgment field turned on, so saving a
 * few requests shows what suggestions are. It holds no documents — suggestions learn only from what
 * a person confirms. Provisional: which domains the app's samples come from is still open.
 */
export function sampleTemplate(id: string): string {
  return `---
id: ${id}
version: 1
lowline:
  suggest: [담당]
---
# ${strings.sampleTemplateName}

요청: ___@요청

@부서: [select options="영업,개발,인사,총무"]

@담당: [radio options="장비,계정,급여,시설"]

@메모: [textarea rows=3]
`
}

export function starterTemplate(id: string): string {
  return `---
id: ${id}
version: 1
---
# ${strings.newTemplateName}

제목: ___@제목

@상태: [select options="열림,진행,닫힘"]

@메모: [textarea rows=4]
`
}
