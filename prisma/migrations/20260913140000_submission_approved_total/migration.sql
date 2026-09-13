-- الإجمالي الفعلي وقت الدفع لجوجل (بعد شطب أي سطور) — Submission.total بيفضل زي ما هو كسجل
-- لما المهندس بعته، وده هو اللي بيتحسب عليه "الإجمالي الفعلي". null = كشف قديم قبل العمود ده
ALTER TABLE `submissions` ADD COLUMN `approved_total` DECIMAL(12, 2) NULL;
