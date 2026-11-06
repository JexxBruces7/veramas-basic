// Terjemahan antarmuka Veramas (bahasa asli: Indonesia).
// Cara kerja: teks & atribut (title, placeholder, aria-label) yang sama persis dengan kunci di bawah diganti
// sesuai bahasa pilihan; teks yang berubah-ubah (angka, laporan) tetap aslinya.
(function () {
  const L = ['en', 'ko', 'ja', 'es', 'ru', 'ar'];
  const R = [
    // header & menu akun
    ['Saldo IDR', 'IDR Balance', 'IDR 잔고', 'IDR残高', 'Saldo IDR', 'Баланс IDR', 'رصيد IDR'],
    ['Equity', 'Equity', '자산', '純資産', 'Patrimonio', 'Капитал', 'حقوق الملكية'],
    ['Unrealized P&L', 'Unrealized P&L', '미실현 손익', '含み損益', 'P&L no realizado', 'Нереализ. P&L', 'الربح غير المحقق'],
    ['Total P&L', 'Total P&L', '총 손익', '合計損益', 'P&L total', 'Общий P&L', 'إجمالي الربح'],
    ['Deposit', 'Deposit', '입금', '入金', 'Depositar', 'Депозит', 'إيداع'],
    ['Saldo simulasi', 'Demo balance', '모의 잔고', 'デモ残高', 'Saldo demo', 'Демо-баланс', 'رصيد تجريبي'],
    ['Hubungkan API', 'Connect API', 'API 연결', 'API接続', 'Conectar API', 'Подключить API', 'ربط API'],
    ['Bot mati', 'Bot stopped', '봇 정지', 'ボット停止中', 'Bot apagado', 'Бот выключен', 'البوت متوقف'],
    ['Bot berjalan', 'Bot running', '봇 실행 중', 'ボット稼働中', 'Bot activo', 'Бот работает', 'البوت يعمل'],
    ['Financial Market', 'Financial Market', '금융 시장', '金融マーケット', 'Mercado financiero', 'Финансовый рынок', 'السوق المالية'],
    ['Market Intelligence · Research Intelligence', 'Market Intelligence · Research Intelligence', '마켓 인텔리전스 · 리서치 인텔리전스', 'マーケット・リサーチ インテリジェンス', 'Market Intelligence · Research Intelligence', 'Market Intelligence · Research Intelligence', 'استخبارات السوق · البحث'],
    ['Bahasa', 'Language', '언어', '言語', 'Idioma', 'Язык', 'اللغة'],
    ['Tema', 'Theme', '테마', 'テーマ', 'Tema', 'Тема', 'المظهر'],
    ['Gelap', 'Dark', '다크', 'ダーク', 'Oscuro', 'Тёмная', 'داكن'],
    ['Terang', 'Light', '라이트', 'ライト', 'Claro', 'Светлая', 'فاتح'],
    ['Install App', 'Install App', '앱 설치', 'アプリをインストール', 'Instalar app', 'Установить приложение', 'تثبيت التطبيق'],
    ['Pasang Veramas seperti aplikasi', 'Install Veramas like an app', 'Veramas을 앱처럼 설치', 'Veramasをアプリとして追加', 'Instala Veramas como app', 'Установить Veramas как приложение', 'ثبّت Veramas كتطبيق'],
    ['Sembunyikan saldo & P&L', 'Hide balance & P&L', '잔고·손익 숨기기', '残高と損益を隠す', 'Ocultar saldo y P&L', 'Скрыть баланс и P&L', 'إخفاء الرصيد والأرباح'],
    ['Tampilkan saldo & P&L', 'Show balance & P&L', '잔고·손익 보기', '残高と損益を表示', 'Mostrar saldo y P&L', 'Показать баланс и P&L', 'إظهار الرصيد والأرباح'],
    ['Tanpa login', 'No login', '로그인 없음', 'ログインなし', 'Sin inicio de sesión', 'Без входа', 'بدون تسجيل دخول'],
    ['Belum masuk', 'Not signed in', '로그인 안 됨', '未ログイン', 'Sin sesión', 'Вход не выполнен', 'لم يتم تسجيل الدخول'],
    ['Buat akun', 'Create account', '계정 만들기', 'アカウント作成', 'Crear cuenta', 'Создать аккаунт', 'إنشاء حساب'],
    ['Masuk', 'Sign in', '로그인', 'ログイン', 'Entrar', 'Войти', 'دخول'],
    ['Keluar', 'Sign out', '로그아웃', 'ログアウト', 'Salir', 'Выйти', 'خروج'],
    ['Ganti kata sandi', 'Change password', '비밀번호 변경', 'パスワード変更', 'Cambiar contraseña', 'Сменить пароль', 'تغيير كلمة المرور'],
    ['Hapus login', 'Remove login', '로그인 해제', 'ログインを解除', 'Quitar inicio de sesión', 'Убрать вход', 'إزالة تسجيل الدخول'],
    ['Masuk ke Veramas', 'Sign in to Veramas', 'Veramas 로그인', 'Veramasにログイン', 'Entrar a Veramas', 'Вход в Veramas', 'تسجيل الدخول إلى Veramas'],
    ['Nama pengguna', 'Username', '사용자 이름', 'ユーザー名', 'Usuario', 'Имя пользователя', 'اسم المستخدم'],
    ['Kata sandi', 'Password', '비밀번호', 'パスワード', 'Contraseña', 'Пароль', 'كلمة المرور'],
    ['Kata sandi lama', 'Old password', '이전 비밀번호', '現在のパスワード', 'Contraseña anterior', 'Старый пароль', 'كلمة المرور القديمة'],
    ['Ulangi kata sandi', 'Repeat password', '비밀번호 확인', 'パスワード（確認）', 'Repite la contraseña', 'Повторите пароль', 'أعد كتابة كلمة المرور'],
    ['Akun ini hanya ada di komputer Anda.', 'This account only exists on your computer.', '이 계정은 내 컴퓨터에만 있습니다.', 'このアカウントはこのPCにのみ保存されます。', 'Esta cuenta solo existe en tu ordenador.', 'Этот аккаунт хранится только на вашем компьютере.', 'هذا الحساب موجود على حاسوبك فقط.'],
    ['Batal', 'Cancel', '취소', 'キャンセル', 'Cancelar', 'Отмена', 'إلغاء'],
    ['Simpan', 'Save', '저장', '保存', 'Guardar', 'Сохранить', 'حفظ'],
    ['Tutup', 'Close', '닫기', '閉じる', 'Cerrar', 'Закрыть', 'إغلاق'],
    // sidebar
    ['Trade Intelligence', 'Trade Intelligence', '트레이드 인텔리전스', 'トレード', 'Trade Intelligence', 'Трейдинг', 'التداول'],
    ['Crypto', 'Crypto', '크립토', '暗号資産', 'Cripto', 'Крипто', 'العملات المشفرة'],
    ['Saham', 'Stocks', '주식', '株式', 'Acciones', 'Акции', 'الأسهم'],
    ['Forex', 'Forex', '외환', 'FX', 'Forex', 'Форекс', 'الفوركس'],
    ['Commodities', 'Commodities', '원자재', 'コモディティ', 'Materias primas', 'Сырьё', 'السلع'],
    ['Property', 'Property', '부동산', '不動産', 'Inmuebles', 'Недвижимость', 'العقارات'],
    ['Macro Economy', 'Macro Economy', '거시경제', 'マクロ経済', 'Macroeconomía', 'Макроэкономика', 'الاقتصاد الكلي'],
    ['Macro Global', 'Global Macro', '글로벌 동향', 'グローバル', 'Macro global', 'Мировые новости', 'الشؤون العالمية'],
    ['Sembunyikan', 'Hide', '숨기기', '隠す', 'Ocultar', 'Скрыть', 'إخفاء'],
    // toolbar & chart
    ['Compare', 'Compare', '비교', '比較', 'Comparar', 'Сравнить', 'مقارنة'],
    ['Indikator', 'Indicators', '지표', 'インジケーター', 'Indicadores', 'Индикаторы', 'المؤشرات'],
    ['📈 Indikator', '📈 Indicators', '📈 지표', '📈 インジケーター', '📈 Indicadores', '📈 Индикаторы', '📈 المؤشرات'],
    ['Alert', 'Alert', '알림', 'アラート', 'Alerta', 'Оповещение', 'تنبيه'],
    ['Replay', 'Replay', '리플레이', 'リプレイ', 'Repetición', 'Повтор', 'إعادة'],
    ['Order Book', 'Order Book', '호가창', '板情報', 'Libro de órdenes', 'Стакан', 'دفتر الأوامر'],
    ['Pilih aset', 'Select asset', '자산 선택', '銘柄を選択', 'Elegir activo', 'Выбрать актив', 'اختر الأصل'],
    ['🪙 Pilih Aset', '🪙 Select Asset', '🪙 자산 선택', '🪙 銘柄を選択', '🪙 Elegir activo', '🪙 Выбор актива', '🪙 اختر الأصل'],
    ['Komoditas', 'Commodities', '원자재', 'コモディティ', 'Materias primas', 'Сырьё', 'السلع'],
    ['Properti', 'Property', '부동산', '不動産', 'Inmuebles', 'Недвижимость', 'العقارات'],
    ['Layar penuh', 'Full screen', '전체 화면', '全画面', 'Pantalla completa', 'Полный экран', 'ملء الشاشة'],
    // order card
    ['Market Order', 'Market Order', '시장가 주문', '成行注文', 'Orden de mercado', 'Рыночный ордер', 'أمر سوق'],
    ['Limit Order', 'Limit Order', '지정가 주문', '指値注文', 'Orden límite', 'Лимитный ордер', 'أمر محدد'],
    ['Market', 'Market', '시장가', '成行', 'Mercado', 'Рынок', 'سوق'],
    ['Limit', 'Limit', '지정가', '指値', 'Límite', 'Лимит', 'محدد'],
    ['SPOT', 'SPOT', '현물', '現物', 'SPOT', 'СПОТ', 'فوري'],
    ['FUTURES', 'FUTURES', '선물', '先物', 'FUTUROS', 'ФЬЮЧЕРСЫ', 'عقود آجلة'],
    ['Jumlah', 'Amount', '금액', '数量', 'Cantidad', 'Сумма', 'المبلغ'],
    ['Stop Loss (%)', 'Stop Loss (%)', '손절 (%)', 'ストップロス (%)', 'Stop Loss (%)', 'Стоп-лосс (%)', 'وقف الخسارة (%)'],
    ['Take Profit (%)', 'Take Profit (%)', '익절 (%)', 'テイクプロフィット (%)', 'Take Profit (%)', 'Тейк-профит (%)', 'جني الأرباح (%)'],
    ['BELI SEKARANG', 'BUY NOW', '지금 매수', '今すぐ買う', 'COMPRAR AHORA', 'КУПИТЬ', 'اشترِ الآن'],
    ['JUAL SEKARANG', 'SELL NOW', '지금 매도', '今すぐ売る', 'VENDER AHORA', 'ПРОДАТЬ', 'بِع الآن'],
    ['BUKA LONG', 'OPEN LONG', '롱 진입', 'ロング', 'ABRIR LONG', 'ОТКРЫТЬ LONG', 'فتح شراء'],
    ['BUKA SHORT', 'OPEN SHORT', '숏 진입', 'ショート', 'ABRIR SHORT', 'ОТКРЫТЬ SHORT', 'فتح بيع'],
    ['Leverage', 'Leverage', '레버리지', 'レバレッジ', 'Apalancamiento', 'Плечо', 'الرافعة'],
    ['Long', 'Long', '롱', 'ロング', 'Long', 'Лонг', 'شراء'],
    ['Short', 'Short', '숏', 'ショート', 'Short', 'Шорт', 'بيع'],
    // bot card
    ['Konfigurasi Bot', 'Bot Settings', '봇 설정', 'ボット設定', 'Configuración del bot', 'Настройки бота', 'إعدادات البوت'],
    ['Strategi', 'Strategy', '전략', '戦略', 'Estrategia', 'Стратегия', 'الاستراتيجية'],
    ['Timeframe strategi', 'Strategy timeframe', '전략 타임프레임', '戦略の時間足', 'Temporalidad de la estrategia', 'Таймфрейм стратегии', 'الإطار الزمني للاستراتيجية'],
    ['Ukuran Trade', 'Trade size', '거래 규모', '取引サイズ', 'Tamaño de operación', 'Размер сделки', 'حجم الصفقة'],
    ['Cek sinyal', 'Check signal', '신호 확인', 'シグナル確認', 'Revisar señal', 'Проверка сигнала', 'فحص الإشارة'],
    ['Saat candle tutup', 'On candle close', '캔들 마감 시', '足確定時', 'Al cierre de vela', 'При закрытии свечи', 'عند إغلاق الشمعة'],
    ['Langsung', 'Live', '실시간', 'リアルタイム', 'En vivo', 'Сразу', 'مباشر'],
    ['Stochastic di bawah', 'Stochastic oversold', '스토캐스틱 과매도', 'ストキャス売られすぎ', 'Estocástico bajo', 'Стохастик внизу', 'ستوكاستك منخفض'],
    ['MACD jadi hijau, tanpa LL', 'MACD turns green, no LL', 'MACD 양전환, LL 없음', 'MACD陽転・安値更新なし', 'MACD a verde, sin LL', 'MACD позеленел, без LL', 'MACD يتحول للأخضر دون قاع أدنى'],
    ['Fibonacci pantul, tanpa LL', 'Fibonacci bounce, no LL', '피보나치 반등, LL 없음', 'フィボ反発・安値更新なし', 'Rebote Fibonacci, sin LL', 'Отскок от Фибо, без LL', 'ارتداد فيبوناتشي دون قاع أدنى'],
    ['Bollinger Band: beli di pita bawah, jual di pita atas', 'Bollinger Band: buy lower band, sell upper band', '볼린저 밴드: 하단 매수, 상단 매도', 'ボリンジャー：下限で買い・上限で売り', 'Bollinger: compra banda inferior, vende superior', 'Боллинджер: покупка у нижней, продажа у верхней', 'بولينجر: شراء عند الحد السفلي وبيع عند العلوي'],
    // panels
    ['Posisi Terbuka', 'Open Positions', '보유 포지션', '保有ポジション', 'Posiciones abiertas', 'Открытые позиции', 'المراكز المفتوحة'],
    ['Order Limit Terbuka', 'Open Limit Orders', '미체결 지정가', '未約定の指値', 'Órdenes límite abiertas', 'Открытые лимитные ордера', 'الأوامر المحددة المفتوحة'],
    ['Riwayat Trade', 'Trade History', '거래 내역', '取引履歴', 'Historial', 'История сделок', 'سجل الصفقات'],
    ['Belum ada posisi', 'No positions yet', '포지션 없음', 'ポジションなし', 'Sin posiciones', 'Позиций нет', 'لا توجد مراكز'],
    ['Tidak ada order limit', 'No limit orders', '지정가 주문 없음', '指値注文なし', 'Sin órdenes límite', 'Лимитных ордеров нет', 'لا توجد أوامر محددة'],
    // indicators
    ['SMA (Simple Moving Average)', 'SMA (Simple Moving Average)', 'SMA (단순 이동평균)', 'SMA（単純移動平均）', 'SMA (media móvil simple)', 'SMA (простая скользящая)', 'SMA (المتوسط المتحرك البسيط)'],
    ['EMA (Exponential Moving Average)', 'EMA (Exponential Moving Average)', 'EMA (지수 이동평균)', 'EMA（指数移動平均）', 'EMA (media móvil exponencial)', 'EMA (экспоненциальная)', 'EMA (المتوسط المتحرك الأسي)'],
    ['Jumlah garis SMA', 'Number of SMA lines', 'SMA 개수', 'SMAの本数', 'Número de SMA', 'Количество SMA', 'عدد خطوط SMA'],
    ['Jumlah garis EMA', 'Number of EMA lines', 'EMA 개수', 'EMAの本数', 'Número de EMA', 'Количество EMA', 'عدد خطوط EMA'],
    ['Periode', 'Period', '기간', '期間', 'Periodo', 'Период', 'الفترة'],
    ['Bollinger Bands', 'Bollinger Bands', '볼린저 밴드', 'ボリンジャーバンド', 'Bandas de Bollinger', 'Полосы Боллинджера', 'نطاقات بولينجر'],
    ['Order Blocks', 'Order Blocks', '오더 블록', 'オーダーブロック', 'Order Blocks', 'Ордер-блоки', 'كتل الأوامر'],
    ['BOS & CHoCH', 'BOS & CHoCH', 'BOS & CHoCH', 'BOS & CHoCH', 'BOS & CHoCH', 'BOS и CHoCH', 'BOS و CHoCH'],
    ['EMA Cross (BUY / SELL)', 'EMA Cross (BUY / SELL)', 'EMA 교차 (매수/매도)', 'EMAクロス（買い/売り）', 'Cruce EMA (COMPRA / VENTA)', 'Пересечение EMA (BUY / SELL)', 'تقاطع EMA (شراء / بيع)'],
    ['Hijau: support utama', 'Green: main support', '초록: 주요 지지', '緑：主要サポート', 'Verde: soporte principal', 'Зелёный: основная поддержка', 'الأخضر: الدعم الرئيسي'],
    ['Merah: resistance utama', 'Red: main resistance', '빨강: 주요 저항', '赤：主要レジスタンス', 'Rojo: resistencia principal', 'Красный: основное сопротивление', 'الأحمر: المقاومة الرئيسية'],
    // API dialog
    ['Exchange terpusat', 'Centralized exchanges', '중앙화 거래소', '中央集権型取引所', 'Exchanges centralizados', 'Централизованные биржи', 'منصات مركزية'],
    ['Dompet & swap', 'Wallets & swaps', '지갑 & 스왑', 'ウォレットとスワップ', 'Billeteras y swaps', 'Кошельки и свопы', 'محافظ وتبديل'],
    ['Data Intelligence', 'Data Intelligence', '데이터 인텔리전스', 'データ・インテリジェンス', 'Data Intelligence', 'Данные и аналитика', 'استخبارات البيانات'],
    ['On-chain, derivatif, riset', 'On-chain, derivatives, research', '온체인, 파생상품, 리서치', 'オンチェーン・デリバティブ・リサーチ', 'On-chain, derivados, investigación', 'Ончейн, деривативы, аналитика', 'على السلسلة، المشتقات، الأبحاث'],
    ['Izinkan trading', 'Allow trading', '거래 허용', '取引を許可', 'Permitir operar', 'Разрешить торговлю', 'السماح بالتداول'],
    // financial market
    ['Market Intelligence', 'Market Intelligence', '마켓 인텔리전스', 'マーケット・インテリジェンス', 'Market Intelligence', 'Рыночная аналитика', 'استخبارات السوق'],
    ['Research Intelligence', 'Research Intelligence', '리서치 인텔리전스', 'リサーチ・インテリジェンス', 'Research Intelligence', 'Исследования', 'استخبارات البحث'],
    ['Encrypt Intelligence', 'Encrypt Intelligence', '암호화폐 지갑 인텔리전스', 'クリプト・インテリジェンス', 'Encrypt Intelligence', 'Крипто-аналитика', 'استخبارات المحافظ'],
    ['📊 Buat Laporan', '📊 Create report', '📊 보고서 생성', '📊 レポート作成', '📊 Crear informe', '📊 Создать отчёт', '📊 إنشاء تقرير'],
    ['🔬 Buat Riset', '🔬 Create research', '🔬 리서치 생성', '🔬 リサーチ作成', '🔬 Crear análisis', '🔬 Создать исследование', '🔬 إنشاء بحث'],
    ['🛰️ Jalankan', '🛰️ Run', '🛰️ 실행', '🛰️ 実行', '🛰️ Ejecutar', '🛰️ Запустить', '🛰️ تشغيل'],
    // market pages
    ['Semua Koin', 'All Coins', '전체 코인', '全コイン', 'Todas las monedas', 'Все монеты', 'كل العملات'],
    ['Naik', 'Gainers', '상승', '上昇', 'Suben', 'Растут', 'الصاعدة'],
    ['Turun', 'Losers', '하락', '下落', 'Bajan', 'Падают', 'الهابطة'],
    ['Pergerakan', 'Movers', '변동', '値動き', 'Movimientos', 'Движение', 'الحركة'],
    ['Saham Teraktif', 'Most Active Stocks', '거래대금 상위', '売買代金上位', 'Acciones más activas', 'Самые активные акции', 'الأسهم الأكثر نشاطاً'],
    ['Sebelumnya', 'Previous', '전일', '前日', 'Anterior', 'Предыдущее', 'السابق'],
    ['Tertinggi', 'High', '고가', '高値', 'Máximo', 'Максимум', 'الأعلى'],
    ['Terendah', 'Low', '저가', '安値', 'Mínimo', 'Минимум', 'الأدنى'],
    ['Kapitalisasi', 'Market cap', '시가총액', '時価総額', 'Capitalización', 'Капитализация', 'القيمة السوقية'],
    ['Naik tertinggi', 'Top gainers', '상승률 상위', '上昇率上位', 'Mayores subidas', 'Лидеры роста', 'الأكثر صعوداً'],
    ['Turun terdalam', 'Top losers', '하락률 상위', '下落率上位', 'Mayores caídas', 'Лидеры падения', 'الأكثر هبوطاً'],
    ['📰 Berita dunia', '📰 World news', '📰 세계 뉴스', '📰 世界のニュース', '📰 Noticias mundiales', '📰 Мировые новости', '📰 أخبار العالم'],
    ['🧭 Ringkasan isu', '🧭 Topic summary', '🧭 이슈 요약', '🧭 トピック概要', '🧭 Resumen de temas', '🧭 Сводка тем', '🧭 ملخص القضايا'],
    ['🌋 Bencana alam terkini', '🌋 Latest natural disasters', '🌋 최신 자연재해', '🌋 最新の自然災害', '🌋 Desastres naturales recientes', '🌋 Последние стихийные бедствия', '🌋 آخر الكوارث الطبيعية'],
    ['🌍 Semua', '🌍 All', '🌍 전체', '🌍 すべて', '🌍 Todo', '🌍 Все', '🌍 الكل'],
    ['🏛️ Pemerintahan', '🏛️ Government', '🏛️ 정부', '🏛️ 政府', '🏛️ Gobierno', '🏛️ Власть', '🏛️ الحكومة'],
    ['🤖 AI & teknologi', '🤖 AI & tech', '🤖 AI·기술', '🤖 AI・テクノロジー', '🤖 IA y tecnología', '🤖 ИИ и технологии', '🤖 الذكاء الاصطناعي'],
    ['🗳️ Politik', '🗳️ Politics', '🗳️ 정치', '🗳️ 政治', '🗳️ Política', '🗳️ Политика', '🗳️ السياسة'],
    ['📢 Isu global', '📢 Global issues', '📢 국제 이슈', '📢 国際問題', '📢 Temas globales', '📢 Мировые темы', '📢 قضايا عالمية'],
    ['🌋 Bencana alam', '🌋 Natural disasters', '🌋 자연재해', '🌋 自然災害', '🌋 Desastres naturales', '🌋 Стихийные бедствия', '🌋 الكوارث الطبيعية'],
    ['🔐 Wallet Treasury', '🔐 Wallet Treasury', '🔐 지갑 보관함', '🔐 ウォレット一覧', '🔐 Tesorería de billeteras', '🔐 Кошельки', '🔐 خزينة المحافظ'],
    ['＋ Tambah wallet', '＋ Add wallet', '＋ 지갑 추가', '＋ ウォレット追加', '＋ Añadir billetera', '＋ Добавить кошелёк', '＋ إضافة محفظة'],
    ['🛰️ Jalankan Encrypt Intelligence', '🛰️ Run Encrypt Intelligence', '🛰️ 인텔리전스 실행', '🛰️ インテリジェンス実行', '🛰️ Ejecutar Encrypt Intelligence', '🛰️ Запустить аналитику', '🛰️ تشغيل الاستخبارات'],
    ['🏘️ Listing Properti', '🏘️ Property Listings', '🏘️ 매물 목록', '🏘️ 物件リスト', '🏘️ Anuncios de inmuebles', '🏘️ Объекты недвижимости', '🏘️ قوائم العقارات'],
    ['＋ Listing', '＋ Listing', '＋ 매물', '＋ 物件', '＋ Anuncio', '＋ Объект', '＋ إضافة'],
    ['📋 Detail properti', '📋 Property details', '📋 매물 상세', '📋 物件詳細', '📋 Detalle', '📋 Детали объекта', '📋 تفاصيل العقار'],
    ['🏗️ Saham properti IDX', '🏗️ IDX property stocks', '🏗️ 인니 부동산 주식', '🏗️ IDX不動産株', '🏗️ Acciones inmobiliarias IDX', '🏗️ Акции девелоперов IDX', '🏗️ أسهم العقارات IDX'],
    ['🧮 Simulasi KPR', '🧮 Mortgage simulator', '🧮 주택담보대출 계산', '🧮 住宅ローン試算', '🧮 Simulador hipotecario', '🧮 Ипотечный калькулятор', '🧮 حاسبة التمويل العقاري'],
    ['📰 Berita kripto', '📰 Crypto news', '📰 크립토 뉴스', '📰 暗号資産ニュース', '📰 Noticias cripto', '📰 Крипто-новости', '📰 أخبار العملات المشفرة'],
    ['🔥 Trending · CoinGecko', '🔥 Trending · CoinGecko', '🔥 트렌딩 · CoinGecko', '🔥 トレンド · CoinGecko', '🔥 Tendencias · CoinGecko', '🔥 В тренде · CoinGecko', '🔥 الرائج · CoinGecko'],
    ['🔥 Trending', '🔥 Trending', '🔥 트렌딩', '🔥 トレンド', '🔥 Tendencia', '🔥 В тренде', '🔥 الرائج'],
    ['📈 Naik', '📈 Gainers', '📈 상승', '📈 上昇', '📈 Suben', '📈 Растут', '📈 الصاعدة'],
    ['📉 Turun', '📉 Losers', '📉 하락', '📉 下落', '📉 Bajan', '📉 Падают', '📉 الهابطة'],
    ['🏆 Top 100', '🏆 Top 100', '🏆 상위 100', '🏆 トップ100', '🏆 Top 100', '🏆 Топ-100', '🏆 أفضل 100'],
    ['🥇 Emas dalam Rupiah', '🥇 Gold in Rupiah', '🥇 루피아 금 시세', '🥇 金（ルピア建て）', '🥇 Oro en rupias', '🥇 Золото в рупиях', '🥇 الذهب بالروبية'],
    ['🥈 Perak dalam Rupiah', '🥈 Silver in Rupiah', '🥈 루피아 은 시세', '🥈 銀（ルピア建て）', '🥈 Plata en rupias', '🥈 Серебро в рупиях', '🥈 الفضة بالروبية'],
    ['↻ Perbarui', '↻ Refresh', '↻ 새로고침', '↻ 更新', '↻ Actualizar', '↻ Обновить', '↻ تحديث'],
  ];
  const D = {}; for (const r of R) { const o = {}; L.forEach((l, i) => { if (r[i + 1]) o[l] = r[i + 1]; }); D[r[0]] = o; }
  const ATTR = ['title', 'placeholder', 'aria-label'], SKIP = /^(SCRIPT|STYLE|TEXTAREA|CODE)$/;
  let LANG = 'id', obs = null; const ORIG = new WeakMap();
  const tr = s => { const k = String(s).trim(); if (!k) return null; const e = D[k]; const t = e && e[LANG]; return t ? String(s).replace(k, t) : null; };
  function text(n) {
    const p = n.parentElement; if (!p || SKIP.test(p.tagName)) return;
    let o = ORIG.get(n); const cur = n.nodeValue;
    if (!o || (cur !== o.t && cur !== o.x)) { o = { t: cur, x: null }; ORIG.set(n, o); }
    const t = LANG === 'id' ? null : tr(o.t); o.x = t; const want = t || o.t; if (n.nodeValue !== want) n.nodeValue = want;
  }
  function attrs(el) {
    for (const a of ATTR) { if (!el.hasAttribute || !el.hasAttribute(a)) continue; const k = 'i18n' + a.replace('-', ''), cur = el.getAttribute(a);
      let orig = el[k + 'o']; if (orig == null || (cur !== orig && cur !== el[k + 'x'])) { orig = cur; el[k + 'o'] = cur; }
      const t = LANG === 'id' ? null : tr(orig); el[k + 'x'] = t; const want = t || orig; if (cur !== want) el.setAttribute(a, want); }
  }
  function walk(root) {
    if (!root) return; if (root.nodeType === 3) return text(root); if (root.nodeType !== 1) return; attrs(root);
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let n; while ((n = tw.nextNode())) text(n);
    root.querySelectorAll('[title],[placeholder],[aria-label]').forEach(attrs);
  }
  function apply(lang) {
    LANG = L.includes(lang) ? lang : 'id'; walk(document.body);
    if (!obs) { obs = new MutationObserver(ms => { for (const m of ms) { if (m.type === 'characterData') text(m.target); else if (m.type === 'attributes') attrs(m.target); else m.addedNodes.forEach(walk); } });
      obs.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTR }); }
  }
  window.TBI18N = { apply, D, langs: ['id', ...L] };
})();
