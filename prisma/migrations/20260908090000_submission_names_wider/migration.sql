-- كشف بمقاولين كتير (11 اسم) كان بيتعدى 190 حرف في contractor_name → الإرسال بيفشل بـ 400
ALTER TABLE `submissions` MODIFY `contractor_name` VARCHAR(1000) NOT NULL, MODIFY `place_name` VARCHAR(1000) NULL;
