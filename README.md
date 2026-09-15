# حرفي قريب

واجهة عربية ثابتة لطلبات الفنيين في جرمانا، تعمل على Supabase وVercel من دون
خادم خاص أو أسرار في المتصفح. لم يعد التطبيق يستخدم `localStorage`.

## إعداد Supabase

1. أنشئ مشروعًا جديدًا في [Supabase](https://supabase.com).
2. من **SQL Editor** الصق الملف `supabase-schema.sql` كاملًا واضغط **Run**.
   ينشئ ذلك الجداول، trigger إنشاء الحساب، RLS، التخزين، وسياسات/RPC المطالبة
   والتقييم وتحديث الحالة وشحن الرصيد.
3. من **Authentication > Providers > Email** فعّل Email. يمكن تعطيل تأكيد
   البريد في التطوير فقط؛ في الإنتاج اتركه مفعّلًا واضبط Site URL وRedirect URLs
   على عنوان Vercel.
4. أنشئ ملفًا محليًا باسم `config.js` بجانب `index.html` (لا ترفع مفتاح
   `service_role` أبدًا):

   ```js
   window.HARFI_CONFIG = {
     supabaseUrl: "https://YOUR_PROJECT.supabase.co",
     supabaseAnonKey: "YOUR_PUBLIC_ANON_KEY"
   };
   ```

   استخدم `config.example.js` كنقطة بداية. قيمة `anon`/publishable عامة ومصممة
   للعمل مع RLS، أما `service_role` فلا يجوز وضعها في HTML أو JavaScript.
   إذا لم يوجد `config.js` أو كانت القيم فارغة، يعرض التطبيق تعليمات الإعداد
   بدل شاشة دخول معطلة.

### إنشاء مدير المنصة

أنشئ حسابًا عاديًا من الواجهة، ثم نفّذ في SQL Editor (بعد استبدال البريد):

```sql
update public.profiles
set role = 'admin'
where id = (select id from auth.users where email = 'admin@example.com');
```

لا يمكن إنشاء مدير عبر نموذج التسجيل. تعديل الدور محمي بـ RLS، لذلك يتم هذا
الإجراء الإداري مرة واحدة من لوحة Supabase.

## تشغيل ونشر Vercel

لا توجد تبعيات npm أو خطوة build مطلوبة. للاختبار المحلي شغّل أي خادم ملفات
ثابت من مجلد المشروع (مثل إضافة Live Server في VS Code)، ثم افتح `index.html`.
فتح الملف مباشرة (`file://`) قد يمنع بعض المتصفحات من تحميل CDN.

في Vercel:

1. ارفع هذا المجلد إلى مستودع Git أو اختر **Import Existing Project**.
2. اختر **Other / Static**، واترك Build Command فارغًا، وOutput Directory
   `.`.
3. انسخ `config.example.js` إلى `config.js` قبل النشر وعدّل القيم، أو عدّل
   قسم `CONFIG` في `app.js`. أضف `config.js` إلى `.gitignore` إذا كان المستودع
   عامًا.
4. أضف رابط النشر إلى Supabase **Authentication > URL Configuration**:
   `https://YOUR-DEPLOYMENT.vercel.app` في Site URL وRedirect URLs.

## قواعد المنتج الموجودة

- كل حساب يبدأ كزبون أو فني؛ الحسابات مرتبطة بـ Supabase Auth و`profiles`.
- أول أربع مطالبات فتح للفني مجانية، وبعدها تخصم RPC آمنة `10,000 ل.س`.
- يمنع `claim_request` أكثر من ثلاثة طلبات نشطة للفني، ويتحقق من الرصيد داخل
  معاملة مع قفل الصف، وليس من JavaScript.
- الزبون والفني يحدّثان مراحل الطلب عبر `update_request_status`، ويمكن لكل طرف
  إرسال تقييم واحد للطرف الآخر عبر `submit_rating`.
- الفني يرفع إيصال شام كاش من لوحة الفني. يظهر للإدارة، ولا يزيد الرصيد إلا
  بعد اعتماد `review_topup_receipt`.
- صور الطلبات والإيصالات ترفع إلى Buckets عامة بسياسات رفع خاصة بمجلد صاحب
  الملف. استخدم buckets خاصة وSigned URLs إذا كانت الصور حساسة في إنتاجك.

## ملفات المشروع

- `index.html`: الهيكل العربي وSupabase CDN.
- `style.css`: التنسيق المتجاوب.
- `app.js`: عميل Supabase، المصادقة، اللوحات، الرفع، واستدعاء RPC.
- `supabase-schema.sql`: المخطط وRLS والتخزين والمنطق الحساس.
- `config.example.js`: قالب الإعداد العام.

