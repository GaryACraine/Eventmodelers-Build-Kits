#!/usr/bin/env bash
# Increment t3: students can unsubscribe; CourseDetails copy 3 (staged as draft).
# Run from your project root on branch increment/t3:  bash ~/Projects/Eventmodelers-Build-Kits/docs/examples/t3.sh
set -euo pipefail

emcli use chapter "Course Enrollment" >/dev/null

emcli slice add "unsubscribe student" >/dev/null
emcli element add "unsubscribe student" Enrollment command unsubscribeStudent >/dev/null
emcli element add "unsubscribe student" "Enrollment Events" event studentWasUnsubscribed >/dev/null
for el in unsubscribeStudent studentWasUnsubscribed; do
  emcli element field add "$el" courseId String --id --example c1 >/dev/null
  emcli element field add "$el" studentId String --id --example s1 >/dev/null
done
emcli dependency add unsubscribeStudent studentWasUnsubscribed produces >/dev/null
emcli element update unsubscribeStudent --api-endpoint "/courses/{courseId}/students/{studentId}" >/dev/null

emcli use slice "unsubscribe student" >/dev/null
emcli spec add "unsubscribes a subscribed student" >/dev/null
emcli use spec "unsubscribes a subscribed student" >/dev/null
emcli spec step add given event studentWasSubscribed --link --seed-examples >/dev/null
emcli spec step add when command unsubscribeStudent --link --seed-examples >/dev/null
emcli spec step add then event studentWasUnsubscribed --link --seed-examples >/dev/null
emcli spec add "rejects unsubscribing a student who is not subscribed" >/dev/null
emcli use spec "rejects unsubscribing a student who is not subscribed" >/dev/null
emcli spec step add when command unsubscribeStudent --link --seed-examples >/dev/null
emcli spec step add then error "Student is not subscribed" >/dev/null

emcli slice add "course details unsubscriptions" >/dev/null
emcli element copy CourseDetails \
  --slice "course details unsubscriptions" --lane Enrollment >/dev/null
emcli element field add "course details unsubscriptions/CourseDetails" subscribedStudents Custom --cardinality List --subfields "studentId:String,name:String" >/dev/null
for e in courseWasRegistered courseCapacityWasChanged studentWasRegistered studentWasSubscribed studentWasUnsubscribed; do emcli dependency add "$e" "course details unsubscriptions/CourseDetails" hydrates >/dev/null; done

emcli use slice "course details unsubscriptions" >/dev/null
emcli spec add "an unsubscribed student is no longer listed" >/dev/null
emcli use spec "an unsubscribed student is no longer listed" >/dev/null
emcli spec step add given event courseWasRegistered --link --seed-examples >/dev/null
emcli spec step add given event studentWasRegistered --link --seed-examples >/dev/null
emcli spec step add given event studentWasSubscribed --link --seed-examples >/dev/null
emcli spec step add given event studentWasUnsubscribed --link --seed-examples >/dev/null
emcli spec step add then readmodel "course details unsubscriptions/CourseDetails" --link --seed-examples >/dev/null
emcli spec step example then 0 subscribedStudents '[]' >/dev/null

emcli slice status "unsubscribe student" planned >/dev/null
emcli slice status "course details unsubscriptions" draft >/dev/null
echo "t3 modeled: 'unsubscribe student' planned, 'course details unsubscriptions' draft"
