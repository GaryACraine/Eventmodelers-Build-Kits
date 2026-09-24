#!/usr/bin/env bash
# Increment t4: courses can be renamed (the answer to the client's note); CourseDetails copy 4 (staged as draft).
# Run from your project root on branch increment/t4:  bash ~/Projects/Eventmodelers-Build-Kits/docs/examples/t4.sh
set -euo pipefail

emcli use chapter "Course Enrollment" >/dev/null

emcli slice add "change course title" >/dev/null
emcli element add "change course title" Enrollment command changeCourseTitle >/dev/null
emcli element add "change course title" "Enrollment Events" event courseTitleWasChanged >/dev/null
for el in changeCourseTitle courseTitleWasChanged; do
  emcli element field add "$el" courseId String --id --example c1 >/dev/null
  emcli element field add "$el" newTitle String --example "Advanced Math" >/dev/null
done
emcli dependency add changeCourseTitle courseTitleWasChanged produces >/dev/null

emcli use slice "change course title" >/dev/null
emcli spec add "renames a registered course" >/dev/null
emcli use spec "renames a registered course" >/dev/null
emcli spec step add given event courseWasRegistered --link --seed-examples >/dev/null
emcli spec step add when command changeCourseTitle --link --seed-examples >/dev/null
emcli spec step add then event courseTitleWasChanged --link --seed-examples >/dev/null
emcli spec add "rejects renaming an unknown course" >/dev/null
emcli use spec "rejects renaming an unknown course" >/dev/null
emcli spec step add when command changeCourseTitle --link --seed-examples >/dev/null
emcli spec step add then error "Course not found" >/dev/null
emcli spec step example when 0 courseId c9 >/dev/null

emcli slice add "course details title" >/dev/null
emcli element copy CourseDetails \
  --slice "course details title" --lane Enrollment >/dev/null
emcli element field add "course details title/CourseDetails" subscribedStudents Custom --cardinality List --subfields "studentId:String,name:String" --mapping "derived:studentWasSubscribed less studentWasUnsubscribed, name from studentWasRegistered" >/dev/null
for e in courseWasRegistered courseCapacityWasChanged studentWasRegistered studentWasSubscribed studentWasUnsubscribed courseTitleWasChanged; do emcli dependency add "$e" "course details title/CourseDetails" hydrates >/dev/null; done

emcli use slice "course details title" >/dev/null
emcli spec add "shows the new title" >/dev/null
emcli use spec "shows the new title" >/dev/null
emcli spec step add given event courseWasRegistered --link --seed-examples >/dev/null
emcli spec step add given event courseTitleWasChanged --link --seed-examples >/dev/null
emcli spec step add then readmodel "course details title/CourseDetails" --link --seed-examples >/dev/null
emcli spec step example then 0 title "Advanced Math" >/dev/null

emcli slice status "change course title" planned >/dev/null
emcli slice status "course details title" draft >/dev/null
echo "t4 modeled: 'change course title' planned, 'course details title' draft"
