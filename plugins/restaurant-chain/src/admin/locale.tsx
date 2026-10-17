import { setupI18n } from "@lingui/core";
import { I18nProvider, useLingui } from "@lingui/react";
import { Select } from "@cloudflare/kumo";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

export const messages = {
	workspace: ["Điều hành nhà hàng", "إدارة المطعم"],
	workspaceHint: [
		"Từ bàn ăn đến bếp, thanh toán và hóa đơn.",
		"من الطاولة إلى المطبخ والدفع والفواتير.",
	],
	brandName: ["Restaurant Chain", "Restaurant Chain"],
	brandTag: ["Quản lý chuỗi", "إدارة السلسلة"],
	navFloor: ["Sơ đồ bàn", "خريطة الطاولات"],
	navOrders: ["Đơn hàng", "الطلبات"],
	navPayments: ["Thanh toán", "المدفوعات"],
	navExports: ["Xuất dữ liệu", "التصدير"],
	navSettings: ["Cài đặt", "الإعدادات"],
	viewFloor: ["Sơ đồ", "الخريطة"],
	viewList: ["Danh sách", "القائمة"],
	tagline: ["Món ngon · Khoảng thời gian đáng nhớ", "طعام شهي · أوقات أجمل"],
	guestOrdering: ["Gọi món tại bàn", "الطلب من الطاولة"],
	scanOrder: [
		"Quét mã QR hoặc chạm NFC để xem thực đơn.",
		"امسح رمز QR أو المس NFC لعرض القائمة.",
	],
	language: ["Ngôn ngữ", "اللغة"],
	branch: ["Chi nhánh", "الفرع"],
	role: ["Vai trò", "الدور"],
	manager: ["Quản lý", "مدير"],
	floor: ["Phục vụ", "خدمة الطاولات"],
	kitchen: ["Bếp", "المطبخ"],
	cashier: ["Thu ngân", "أمين الصندوق"],
	accountant: ["Kế toán", "محاسب"],
	tables: ["Bàn & yêu cầu", "الطاولات والطلبات"],
	payments: ["Thanh toán & hóa đơn", "الدفع والفواتير"],
	configuration: ["Thiết lập", "الإعدادات"],
	exports: ["Xuất dữ liệu", "تصدير البيانات"],
	refresh: ["Làm mới", "تحديث"],
	loading: ["Đang tải…", "جار التحميل…"],
	saving: ["Đang xử lý…", "جار التنفيذ…"],
	save: ["Lưu thay đổi", "حفظ التغييرات"],
	saved: ["Đã lưu", "تم الحفظ"],
	error: ["Không thể hoàn tất yêu cầu.", "تعذر إتمام الطلب."],
	retry: ["Thử lại", "إعادة المحاولة"],
	network: [
		"Kiểm tra kết nối rồi thử lại. Nội dung của bạn vẫn được giữ.",
		"تحقق من الاتصال ثم أعد المحاولة. تم الاحتفاظ بمدخلاتك.",
	],
	conflict: [
		"Dữ liệu đã thay đổi. Làm mới và kiểm tra trước khi gửi lại; nội dung nhập vẫn được giữ.",
		"تغيرت البيانات. حدّثها وراجعها قبل الإرسال مجدداً؛ تم الاحتفاظ بالمدخلات.",
	],
	forbidden: [
		"Bạn không có quyền thực hiện thao tác này tại chi nhánh.",
		"ليس لديك صلاحية تنفيذ هذا الإجراء في الفرع.",
	],
	closed: [
		"Lượt phục vụ đã kết thúc. Vui lòng liên hệ nhân viên để mở bàn.",
		"انتهت الجلسة. يرجى التواصل مع الموظفين لفتح الطاولة.",
	],
	invalid: ["Vui lòng kiểm tra các trường và thử lại.", "يرجى مراجعة الحقول والمحاولة مجدداً."],
	empty: ["Chưa có dữ liệu.", "لا توجد بيانات بعد."],
	noBranches: [
		"Chưa có chi nhánh được phân quyền. Quản trị viên có thể tạo chi nhánh trong Thiết lập.",
		"لم يتم تعيين فرع لك. يمكن للمسؤول إنشاء فرع من الإعدادات.",
	],
	openVisit: ["Mở bàn", "فتح الطاولة"],
	closeVisit: ["Kết thúc lượt", "إنهاء الجلسة"],
	visit: ["Lượt phục vụ", "جلسة الخدمة"],
	table: ["Bàn", "الطاولة"],
	active: ["Hoạt động", "نشط"],
	inactive: ["Ngừng hoạt động", "غير نشط"],
	open: ["Đang phục vụ", "مفتوحة"],
	frozen: ["Đã chốt", "مغلقة للحساب"],
	closedState: ["Đã kết thúc", "منتهية"],
	pending: ["Chờ xác nhận", "بانتظار التأكيد"],
	confirmed: ["Đã xác nhận", "مؤكد"],
	rejected: ["Đã từ chối", "مرفوض"],
	voided: ["Đã hủy", "ملغى"],
	queued: ["Đang chờ bếp", "في قائمة المطبخ"],
	preparing: ["Đang chế biến", "قيد التحضير"],
	ready: ["Sẵn sàng phục vụ", "جاهز للتقديم"],
	served: ["Đã phục vụ", "تم التقديم"],
	confirm: ["Xác nhận món", "تأكيد الطلب"],
	reject: ["Từ chối", "رفض"],
	void: ["Hủy đơn", "إلغاء الطلب"],
	reason: ["Lý do", "السبب"],
	prepare: ["Bắt đầu chế biến", "بدء التحضير"],
	markReady: ["Món đã sẵn sàng", "الطلب جاهز"],
	markServed: ["Đã giao món", "تم تقديم الطلب"],
	requests: ["Yêu cầu gọi món", "طلبات الطعام"],
	items: ["Món ăn", "الأطباق"],
	quantity: ["Số lượng", "الكمية"],
	note: ["Ghi chú", "ملاحظات"],
	bill: ["Chi tiết tạm tính", "تفاصيل الحساب"],
	total: ["Tổng cộng", "الإجمالي"],
	paid: ["Đã thanh toán", "مدفوع"],
	unpaid: ["Chưa thanh toán", "غير مدفوع"],
	createPayment: ["Chốt hóa đơn & tạo QR", "تثبيت الحساب وإنشاء رمز الدفع"],
	paymentWarning: [
		"Kiểm tra món đang chờ và tiến độ bếp trước khi chốt. QR cũ vẫn có thể nhận chuyển khoản.",
		"راجع الطلبات المعلقة وحالة المطبخ قبل تثبيت الحساب. قد تستقبل رموز الدفع القديمة حوالات.",
	],
	paymentReference: ["Nội dung chuyển khoản", "مرجع التحويل"],
	bank: ["Mã ngân hàng", "رمز البنك"],
	account: ["Số tài khoản", "رقم الحساب"],
	bankName: ["Tên ngân hàng (gateway SePay)", "اسم البنك (بوابة SePay)"],
	qr: ["Mã QR thanh toán", "رمز الدفع"],
	invoices: ["Hóa đơn điện tử", "الفواتير الإلكترونية"],
	buyer: ["Người mua", "المشتري"],
	buyerName: ["Tên người mua / đơn vị", "اسم المشتري أو المؤسسة"],
	taxCode: ["Mã số thuế", "الرقم الضريبي"],
	address: ["Địa chỉ", "العنوان"],
	email: ["Email nhận hóa đơn", "البريد الإلكتروني للفاتورة"],
	createInvoice: ["Lập hóa đơn", "إنشاء فاتورة"],
	issueInvoice: ["Phát hành hóa đơn", "إصدار الفاتورة"],
	correction: ["Điều chỉnh / thay thế", "تعديل أو استبدال"],
	adjustment: ["Điều chỉnh", "تعديل"],
	replacement: ["Thay thế", "استبدال"],
	reconcile: ["Đối soát trạng thái", "مطابقة الحالة"],
	unknownWarning: [
		"Chưa biết kết quả phía nhà cung cấp. Chỉ đối soát; không gửi lại yêu cầu phát hành.",
		"نتيجة المزود غير معروفة. طابق الحالة فقط؛ لا تعاود إرسال طلب الإصدار.",
	],
	draft: ["Bản nháp", "مسودة"],
	create_pending: ["Chờ lập hóa đơn", "بانتظار الإنشاء"],
	created: ["Đã lập", "تم الإنشاء"],
	issue_pending: ["Chờ phát hành", "بانتظار الإصدار"],
	issued: ["Đã phát hành", "صادرة"],
	failed: ["Thất bại", "فشل"],
	outcome_unknown: ["Chưa rõ kết quả", "نتيجة غير معروفة"],
	processing: ["Đang xử lý", "قيد المعالجة"],
	matched: ["Đã khớp", "مطابق"],
	superseded: ["Đã thay thế", "مستبدل"],
	providerStatus: ["Trạng thái nhà cung cấp", "حالة المزود"],
	taxStatus: ["Trạng thái cơ quan thuế", "حالة جهة الضرائب"],
	downloadPdf: ["Tải PDF", "تنزيل PDF"],
	downloadXml: ["Tải XML", "تنزيل XML"],
	fromDate: ["Từ ngày", "من تاريخ"],
	toDate: ["Đến ngày", "إلى تاريخ"],
	exportType: ["Loại dữ liệu", "نوع البيانات"],
	sales: ["Chi tiết doanh thu", "بنود المبيعات"],
	audit: ["Lịch sử & điều chỉnh", "السجل والتعديلات"],
	download: ["Tải CSV", "تنزيل CSV"],
	exportHint: [
		"Ngày kinh doanh theo Asia/Ho_Chi_Minh. Dữ liệu gốc để hạch toán, không phải sổ cái.",
		"تواريخ العمل حسب Asia/Ho_Chi_Minh. بيانات أولية للمحاسبة وليست دفتر أستاذ.",
	],
	branches: ["Chi nhánh & pháp nhân", "الفروع والجهات القانونية"],
	members: ["Phân quyền nhân viên", "صلاحيات الموظفين"],
	menuConfig: ["Thực đơn", "قائمة الطعام"],
	newRecord: ["Tạo mới", "إنشاء جديد"],
	edit: ["Chỉnh sửa", "تعديل"],
	cancel: ["Hủy", "إلغاء"],
	name: ["Tên", "الاسم"],
	code: ["Mã", "الرمز"],
	userId: ["ID người dùng EmDash", "معرّف مستخدم EmDash"],
	issuerName: ["Tên pháp nhân xuất hóa đơn", "اسم الجهة المصدرة"],
	issuerContext: ["Mã cấu hình hóa đơn", "معرّف إعداد الفواتير"],
	paymentContext: ["Mã cấu hình SePay", "معرّف إعداد SePay"],
	environment: ["Môi trường", "البيئة"],
	sandbox: ["Thử nghiệm", "اختبار"],
	live: ["Thực tế", "إنتاج"],
	contextHint: [
		"Chỉ lưu mã cấu hình. Khóa bí mật được cấu hình trên Cloudflare, không nhập ở đây.",
		"احفظ معرّفات الإعداد فقط. تُضبط المفاتيح السرية في Cloudflare وليس هنا.",
	],
	category: ["Nhóm món", "الفئة"],
	description: ["Mô tả", "الوصف"],
	image: ["Đường dẫn ảnh", "رابط الصورة"],
	price: ["Giá (VND)", "السعر (VND)"],
	taxRate: ["Thuế suất đã cấu hình", "نسبة الضريبة المحددة"],
	available: ["Đang bán", "متاح"],
	unavailable: ["Tạm hết món", "غير متاح حالياً"],
	modifiers: ["Tùy chọn món", "خيارات الطبق"],
	modifierId: ["Mã tùy chọn", "معرّف الخيار"],
	addModifier: ["Thêm tùy chọn", "إضافة خيار"],
	remove: ["Xóa", "حذف"],
	tableLink: ["Liên kết QR / NFC", "رابط QR / NFC"],
	menu: ["Thực đơn tại bàn", "قائمة الطاولة"],
	welcome: ["Chọn món ngon, tận hưởng bữa ăn.", "اختر أطباقك واستمتع بوجبتك."],
	guestHint: [
		"Món chỉ được chuyển tới bếp sau khi nhân viên xác nhận.",
		"تُرسل الأطباق للمطبخ بعد تأكيد الموظفين فقط.",
	],
	join: ["Bắt đầu gọi món", "بدء الطلب"],
	joinHint: ["Kết nối với lượt phục vụ hiện tại của bàn.", "انضم إلى جلسة الخدمة الحالية للطاولة."],
	all: ["Tất cả", "الكل"],
	search: ["Tìm món", "بحث عن طبق"],
	add: ["Thêm món", "إضافة الطبق"],
	basket: ["Món đã chọn", "الأطباق المختارة"],
	orderAtTable: ["Đặt món tại bàn", "اطلب من الطاولة"],
	basketEmpty: ["Chọn một món từ thực đơn để bắt đầu.", "اختر طبقاً من القائمة للبدء."],
	submit: ["Gửi yêu cầu gọi món", "إرسال طلب الطعام"],
	sent: [
		"Đã gửi yêu cầu. Nhân viên sẽ xác nhận món cho bạn.",
		"تم إرسال الطلب. سيؤكد الموظفون الأطباق لك.",
	],
	status: ["Theo dõi món & tạm tính", "متابعة الطلب والحساب"],
	noOrders: ["Chưa có yêu cầu gọi món.", "لا توجد طلبات طعام بعد."],
	noMenu: [
		"Chưa có món phù hợp. Hãy đổi nhóm món hoặc liên hệ nhân viên.",
		"لا توجد أطباق مطابقة. غيّر الفئة أو تواصل مع الموظفين.",
	],
	estimate: [
		"Tạm tính, chưa bao gồm thay đổi khi xác nhận.",
		"تقدير أولي قابل للتغيير عند التأكيد.",
	],
	online: ["Cập nhật tự động khi có kết nối", "تحديث تلقائي عند الاتصال"],
	backToMenu: ["Tiếp tục chọn món", "متابعة اختيار الأطباق"],
	pendingHint: [
		"Đã gửi, chưa được tính vào hóa đơn cho tới khi xác nhận.",
		"تم الإرسال ولن يُضاف للحساب حتى التأكيد.",
	],
	paymentHint: [
		"Thanh toán với thu ngân. Không chuyển khoản khi chưa kiểm tra đúng chi nhánh và số tiền.",
		"ادفع لدى أمين الصندوق. تحقق من الفرع والمبلغ قبل التحويل.",
	],
	unsaved: ["Bạn có nội dung chưa gửi. Rời trang?", "لديك مدخلات لم تُرسل. هل تريد المغادرة؟"],
	selectVisit: ["Chọn lượt phục vụ", "اختر جلسة الخدمة"],
	statusOther: ["Trạng thái khác", "حالة أخرى"],
	providerAccount: ["ID tài khoản nhà cung cấp (UUID)", "معرّف حساب المزود (UUID)"],
	sellerStore: [
		"ID địa điểm xuất hóa đơn (UUID, tùy chọn)",
		"معرّف موقع إصدار الفاتورة (UUID، اختياري)",
	],
	template: ["Mẫu hóa đơn", "قالب الفاتورة"],
	series: ["Ký hiệu hóa đơn", "سلسلة الفاتورة"],
	subAccount: ["Tài khoản phụ", "الحساب الفرعي"],
	taxHint: [
		"Thuế suất theo điểm cơ bản: 500 = 5%, 800 = 8%, 1000 = 10%. Giá đã gồm thuế.",
		"النسبة بنقاط الأساس: 500 = 5%، 800 = 8%، 1000 = 10%. السعر شامل الضريبة.",
	],
	adjustmentHint: [
		"Chỉ nhập phần chênh lệch: giá dương để tăng, giá âm để giảm. Không nhập lại toàn bộ hóa đơn. Đổi loại sẽ đặt lại các dòng.",
		"أدخل الفرق فقط: سعر موجب للزيادة وسالب للنقصان، وليس كامل الفاتورة. تغيير النوع يعيد ضبط البنود.",
	],
	replacementHint: [
		"Nhập toàn bộ nội dung hóa đơn thay thế. Đổi loại sẽ đặt lại các dòng.",
		"أدخل كامل محتوى الفاتورة البديلة. تغيير النوع يعيد ضبط البنود.",
	],
	billing: ["Đang thanh toán", "قيد الدفع"],
	exception: ["Cần đối soát", "تحتاج إلى مطابقة"],
	dispatching: ["Đang gửi nhà cung cấp", "جار الإرسال إلى المزود"],
	cancelled: ["Đã hủy", "ملغى"],
	next: ["Trang tiếp", "الصفحة التالية"],
	previous: ["Trang trước", "الصفحة السابقة"],
	loadMore: ["Xem thêm", "عرض المزيد"],
	exceptions: ["Chuyển khoản cần đối soát", "حوالات تحتاج إلى مطابقة"],
	jobs: ["Tác vụ nhà cung cấp", "مهام المزود"],
	tracking: ["Mã theo dõi", "رمز التتبع"],
	qrMode: ["Cách nhận tiền QR", "طريقة استلام دفع QR"],
	direct: ["Tài khoản ngân hàng", "الحساب البنكي"],
	virtual: ["Tài khoản định danh (VA)", "حساب افتراضي (VA)"],
	memo: ["Tài khoản phụ qua nội dung TKP", "حساب فرعي عبر مرجع TKP"],
	transferPrefix: ["Tiền tố chuyển khoản", "بادئة مرجع التحويل"],
	qrConfigHint: [
		"Nhập đúng cấu hình nhận tiền do SePay cung cấp. Chế độ trực tiếp để trống tài khoản phụ; VA/TKP cần tài khoản phụ. Không lặp TKP trong tiền tố.",
		"أدخل إعدادات الاستلام المحددة من SePay. اترك الحساب الفرعي فارغاً للحساب المباشر؛ يلزم لحساب VA/TKP. لا تكرر TKP في البادئة.",
	],
	tableQr: ["Mã QR gọi món tại bàn", "رمز قائمة الطاولة"],
	downloadQr: ["Tải mã QR (PNG)", "تنزيل رمز QR (PNG)"],
	print: ["In mã bàn", "طباعة رمز الطاولة"],
	copyLink: ["Sao chép liên kết NFC", "نسخ رابط NFC"],
	copied: ["Đã sao chép", "تم النسخ"],
	basketLimit: [
		"Mỗi yêu cầu tối đa 50 dòng món. Gửi yêu cầu này trước khi chọn thêm.",
		"الحد الأقصى 50 بنداً لكل طلب. أرسل هذا الطلب قبل إضافة المزيد.",
	],
	partialData: [
		"Đang hiển thị một phần dữ liệu. Xem thêm để tải đầy đủ chi tiết trước khi điều chỉnh hóa đơn.",
		"تُعرض بيانات جزئية. اعرض المزيد لتحميل جميع التفاصيل قبل تعديل الفاتورة.",
	],
	unsettled: ["Món chưa phục vụ", "أطباق لم تُقدَّم بعد"],
	navShift: ["Ca làm việc", "الوردية"],
	shift: ["Ca làm việc", "الوردية"],
	shiftHistory: ["Lịch sử ca", "سجل الورديات"],
	openShift: ["Mở ca", "فتح الوردية"],
	closeShift: ["Chốt ca", "إغلاق الوردية"],
	openingFloat: ["Tiền đầu ca", "رصيد بداية الوردية"],
	countedCash: ["Tiền mặt kiểm đếm", "النقد المعدود"],
	expectedCash: ["Tiền mặt dự kiến", "النقد المتوقع"],
	variance: ["Chênh lệch", "الفرق"],
	shiftOpenedAt: ["Mở lúc", "فُتحت في"],
	shiftSales: ["Doanh thu trong ca", "مبيعات الوردية"],
	cash: ["Tiền mặt", "نقداً"],
	bankTransfer: ["Chuyển khoản", "تحويل بنكي"],
	noOpenShift: [
		"Chưa mở ca. Mở ca trước khi thu tiền mặt.",
		"لم تُفتح وردية. افتح وردية قبل تحصيل النقد.",
	],
	bills: ["Hóa đơn", "الحسابات"],
	openBills: ["Hóa đơn chờ thu", "حسابات بانتظار الدفع"],
	settledBills: ["Hóa đơn đã thu", "حسابات مدفوعة"],
	freezeBill: ["Chốt bill", "تثبيت الحساب"],
	freezeHint: [
		"Chốt bill khóa các món đã phục vụ của bàn và tạo hóa đơn chờ thu một phương thức.",
		"تثبيت الحساب يقفل الأطباق المقدمة وينشئ فاتورة بانتظار الدفع بطريقة واحدة.",
	],
	settleBill: ["Xác nhận đã thu", "تأكيد الاستلام"],
	method: ["Phương thức", "طريقة الدفع"],
	transferReference: ["Mã tham chiếu chuyển khoản", "مرجع التحويل"],
	received: ["Đã kiểm tra tiền thực nhận", "تم التحقق من المبلغ المستلم فعلاً"],
	settleWarning: [
		"Chỉ xác nhận đã thu sau khi kiểm tra tiền thực nhận.",
		"لا تؤكد الاستلام قبل التحقق من المبلغ الفعلي.",
	],
	noBills: ["Chưa có hóa đơn.", "لا توجد حسابات بعد."],
	shiftRequired: ["Cần mở ca trước khi thu tiền mặt.", "افتح وردية قبل تحصيل النقد."],
	readOnlyHint: [
		"Chỉ xem. Quản lý hoặc thu ngân thực hiện thao tác này.",
		"للعرض فقط. ينفّذ المدير أو أمين الصندوق هذا الإجراء.",
	],
	openBillsHint: [
		"Còn hóa đơn chờ thu trong ca. Chốt bill và thu tiền trước khi chốt ca.",
		"ما زالت هناك حسابات بانتظار الدفع في الوردية. ثبّت الحسابات وحصّل المبالغ قبل إغلاق الوردية.",
	],
	done: ["Đã xử lý", "تمت المعالجة"],
	callWaiter: ["Gọi nhân viên", "طلب الموظف"],
	requestBill: ["Yêu cầu tính tiền", "طلب الحساب"],
	serviceRequests: ["Yêu cầu phục vụ", "طلبات الخدمة"],
	attendRequest: ["Đã xử lý", "تمت المعالجة"],
	requestSent: [
		"Đã gửi yêu cầu. Nhân viên sẽ tới bàn.",
		"تم إرسال الطلب. سيأتي الموظف إلى الطاولة.",
	],
	alreadyRequested: ["Yêu cầu này đang chờ xử lý.", "هذا الطلب قيد المعالجة."],
	noRequests: ["Không có yêu cầu nào.", "لا توجد طلبات."],
	offline: [
		"Đang mất kết nối. Thao tác chưa được xác nhận sẽ được gửi lại khi có mạng.",
		"انقطع الاتصال. ستُعاد المحاولة عند توفر الشبكة.",
	],
	backOnline: ["Đã kết nối lại.", "تم الاتصال مجدداً."],
	needsCleaning: ["Cần dọn bàn", "تحتاج إلى تنظيف"],
	cleanTable: ["Đã dọn bàn", "تم تنظيف الطاولة"],
	dirty: ["Cần dọn bàn", "تحتاج إلى تنظيف"],
} as const;
export type TextKey = keyof typeof messages;
const LocaleContext = createContext<{ locale: string; setLocale: (locale: string) => void }>({
	locale: "vi",
	setLocale: () => {},
});

export function RestaurantLocale({ children }: { children: ReactNode }) {
	const [locale, setLocale] = useState(() =>
		typeof document !== "undefined" && document.documentElement.lang.startsWith("ar") ? "ar" : "vi",
	);
	const i18n = useMemo(
		() =>
			setupI18n({
				locale,
				messages: {
					[locale]: Object.fromEntries(
						Object.entries(messages).map(([id, values]) => [id, values[locale === "ar" ? 1 : 0]]),
					),
				},
			}),
		[locale],
	);
	useEffect(() => {
		const previousLanguage = document.documentElement.lang;
		const previousDirection = document.documentElement.dir;
		document.documentElement.lang = locale;
		document.documentElement.dir = locale === "ar" ? "rtl" : "ltr";
		return () => {
			document.documentElement.lang = previousLanguage;
			document.documentElement.dir = previousDirection;
		};
	}, [locale]);
	return (
		<LocaleContext.Provider value={{ locale, setLocale }}>
			<I18nProvider i18n={i18n}>
				<div lang={locale} dir={locale === "ar" ? "rtl" : "ltr"}>
					{children}
				</div>
			</I18nProvider>
		</LocaleContext.Provider>
	);
}

export function useText() {
	const { i18n } = useLingui();
	const { locale } = useContext(LocaleContext);
	return { t: (key: TextKey) => i18n._(key), locale };
}

export function LanguageSelect() {
	const { t } = useText();
	const { locale, setLocale } = useContext(LocaleContext);
	return (
		<Select
			label={t("language")}
			value={locale}
			items={{ vi: "Tiếng Việt", ar: "العربية" }}
			onValueChange={(value) => {
				if (value === "vi" || value === "ar") setLocale(value);
			}}
		/>
	);
}

export function statusKey(value: string): TextKey {
	return Object.hasOwn(messages, value) ? (value as TextKey) : "statusOther";
}
